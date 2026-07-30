# GraphState Memory 设计文档

> 状态：设计稿，待评审
> 背景：取数与 Coder 对接不上、Coder 常硬编码。根因是"无 memory 机制 + 纯参数透传"，
> 决策散落丢失。本设计引入 GraphState 作为 Loop Engine 的记忆层，统一承载流程图状态与决策。

---

## 一、问题与目标

### 现状根因

1. **无 memory 机制**：每个 LLM 调用是无状态单轮，跨阶段上下文 100% 靠 `pendingRun` 字段透传，
   且只传结论不传决策理由。Planner 的 analysis、模板匹配的 layoutReason 产出后即丢弃。
2. **产物与决策混存**：`pendingRun.dataBlock`（8-16KB 全文）与决策字段混在一个对象里，
   memory 寄生在 Run 上，无法独立演进。
3. **跨轮决策丢失**：edit 流程只复用产物（`lastDataBlock`），不复用上轮决策，Coder 拿到裸数据不知用途映射。

### 目标

引入 **GraphState** 作为 Loop Engine 的一等公民（核心构成），统一承载：
- 流程图状态（节点 + 转移 + 当前态）
- 各节点决策摘要（业务填写，机制不解释）
- 产物引用（指向产物本体，不存本体）

---

## 二、核心抽象

### 2.1 概念分层

```
┌─ Loop Engine ───────────────────────────────────────────────┐
│                                                              │
│  ① Memory（引擎固有，一等公民）                               │
│     = GraphState 数据 + load/commit/restore 三个纯操作        │
│     只存：图状态 + 决策摘要 + 产物引用(ref)                    │
│     绝不存：产物本体                                          │
│     不维持版本概念（版本是 Version 的职责）                    │
│                                                              │
│  ② Artifacts 产物层（独立存储，Memory 用 ref 指向）           │
│     dataBlock 全文 / HTML / inventory / mapPaths             │
│     按版本目录组织：previews/<dashId>/<verId>/                │
│                                                              │
│  ③ Version（已有概念，唯一版本来源）                          │
│     产物（html 等） + memory（GraphState 快照）               │
│     回退 = 载入目标版本的 memory                              │
│                                                              │
│  ④ Stage 机制（可定义/迭代/扩展）                             │
│     向 GraphState 写：状态转移、节点决策、产物 ref             │
│     从 GraphState 读：任务初始读当前图状态                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 三条铁律

1. **Memory 与产物分离**：GraphState 只存 ref（产物定位串），产物本体在 Artifacts 层。
2. **Memory 与 Stage 解耦**：GraphState 机制只提供"存图状态/读图状态"，不认识 planner/fetch/coder 等业务节点名。
3. **Memory 不管版本**：版本管理归 `Version`（已有），GraphState 是 Version 的一个组成部分。
   切换版本 = 载入对应 memory，与载入对应 HTML 产物对称。

### 2.3 关键设计决策（推演结论）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| memory 粒度 | GraphState（完整图状态快照） | 非按 kind/proposition/event 拆分，避免业务逻辑侵入机制 |
| 回灌策略 | 每个任务初始时整体读取当前图状态 | 不筛选不检索，确定性高 |
| 版本快照 vs 扩展图 | 版本快照链（V） | V 是 B 的高阶抽象，完整性是结构属性而非维护约束 |
| 快照存全量 vs diff | **全量** | diff 模式为省几百字节引入累计复杂度+脆弱性，不值得 |
| memory 是否管版本 | **不管，是 Version 的一部分** | 消除平行版本管理，版本号唯一来源是 rt.s.versions |
| 中间态如何存 | ActiveRun.memory（与 run.html 同构） | 未提交运行态，commit 时 freeze 进 Version |
| steps 是否进 GraphState | **不进** | steps 是动作流水（UI 旁路），不是决策；memory 只记决策不记过程 |
| definition 位置 | GraphState 内（每版本带） | 让版本自洽，冗余可忽略 |

---

## 三、数据结构

### 3.1 GraphState

```ts
/**
 * GraphState：流程在某一刻的完整图状态。
 * - 嵌在 Version 里 = 已提交的不可变快照（与 html 产物对称）
 * - 挂在 ActiveRun 里 = 未提交的运行态（与 run.html 对称）
 * - 只存图状态 + 节点产出 + 产物引用，绝不存产物本体
 * - 机制不认识节点名的业务含义，output/refKey 是业务填充的不透明数据
 */
interface GraphState {
  /** 流程定义：有哪些节点、允许的转移（流程层填写，机制不解释） */
  definition: FlowDefinition
  /** 各节点当前状态（图的核心） */
  nodes: Record<NodeId, NodeState>
  /** 流程当前停在哪个节点（流程指针） */
  current: NodeId
  /** 卡点挂起原因；null = 正在推进或已结束 */
  awaiting: 'clarification' | 'problem' | 'llm' | null
}

interface FlowDefinition {
  nodes: Array<{ id: NodeId; name: string }>
  edges: Array<{ from: NodeId; to: NodeId }>
}

interface NodeState {
  status: 'pending' | 'active' | 'done' | 'failed'
  /** 节点承载的信息（业务语义，机制不解释：可能是决策、结果总结、重要信息等） */
  output?: NodeOutput
  /** 指向产物层的引用（键名由业务定，值是产物定位串） */
  refs?: Record<string, string>
}

/** 节点承载的信息。业务自由填写，机制只存不解释 */
interface NodeOutput {
  [key: string]: unknown
}

type NodeId = string
```

### 3.2 大屏流程各节点的 output 形态（业务约定，非机制约束）

> 节点承载的信息形态由业务层约定，机制不约束。下面是大屏流程各节点实际填的内容
> （可能是决策、结果总结或重要信息，统称为"承载信息"）：

```ts
// planner 节点
{
  analysis: string           // 需求理解（现在丢弃，救回）
  mapAdcode: string          // 地图行政区划码
  answersSummary: string     // 澄清答案汇总
}

// match 节点
{
  layoutId: string | null
  layoutReason: string       // 匹配理由（现在丢弃，救回）
  modules: MatchModule[]     // 模块化匹配结果
  useTemplate: boolean
}

// fetch 节点
{
  usage: Array<{             // 数据用途->面板映射（新增，直击硬编码）
    purpose: string          // 取数规划给的用途
    panel: string            // 该数据画到哪个面板
  }>
  summary: string            // 取数摘要
}

// coder 节点
{
  summary: string            // 编码摘要
}

// check 节点
{
  issueIds: string[]         // 发现的问题 id
}

// repair 节点
{
  failCount: number
  lastIssueId: string | null
}
```

### 3.3 与现有载体的关系

```ts
/** Version 扩展：内嵌 memory */
interface Version {
  // ...现有字段不变
  html, screenshotUrl, dataSourcesUsed, published, isCurrent...
  /** 新增：该版本的完整图状态快照（commit 时从 run.graphState freeze） */
  memory?: GraphState
}

/** ActiveRun 扩展：未提交运行态 */
interface ActiveRun {
  pending: PendingRun        // 瘦身：只剩 text/attachments/kind 等纯输入
  html: string               // 未提交产物（现有）
  /** 新增：未提交的图状态（与 run.html 同构） */
  graphState: GraphState
  retryRepair, retryLlm, proceed...  // 控制流闭包（现有不变）
}
```

### 3.4 Memory 机制：三个纯操作

```ts
/** Memory 机制本身无状态，只是 GraphState 的存取操作 */
const Memory = {
  /** 从版本载入图状态（回退/编辑复用时） */
  loadFrom(version: Version): GraphState {
    return version.memory ?? emptyGraphState()
  },

  /** 运行态图状态 freeze 进版本（commit 时） */
  commitTo(version: Version, graphState: GraphState): void {
    version.memory = deepClone(graphState)
  },

  /** 版本图状态载入运行态（回退后继续编辑） */
  restoreTo(run: ActiveRun, version: Version): void {
    run.graphState = deepClone(version.memory ?? emptyGraphState())
  }
}
```

---

## 四、产物层（Artifacts）

### 4.1 存储布局

复用现有 `previews/<dashId>/<verId>/` 目录，与 HTML 同级：

```
previews/<dashId>/<verId>/
  index.html          ← 现有：大屏 HTML 产物
  data-used.json      ← 现有：取数明细
  data-block.txt      ← 新增：dataBlock 全文（从 session.json 移出）
  inventory.json      ← 新增：精读清单（从 session.json 移出）
  map-paths.json      ← 新增：地图 SVG 路径（从 session.json 移出）
```

### 4.2 GraphState 中的 ref 形态

ref 值是相对版本目录的文件名：

```ts
nodes.fetch.refs = {
  dataBlockRef: 'data-block.txt',      // 取数产物全文
  dataUsedRef: 'data-used.json'        // 取数明细
}
nodes.planner.refs = {
  inventoryRef: 'inventory.json',      // 精读清单
  mapPathsRef: 'map-paths.json'        // 地图路径
}
nodes.coder.refs = {
  htmlRef: 'index.html'                // 大屏 HTML（已存在于版本目录）
}
```

### 4.3 Store 层新增方法

```ts
// store.ts 新增
writeArtifact(dashId: string, versionId: string, fileName: string, content: string): void
readArtifact(dashId: string, versionId: string, fileName: string): string | null
```

---

## 五、字段迁移映射

### 5.1 节点承载信息类 -> `nodes[nodeId].output`

| 现有字段 | 位置 | 归到 | 备注 |
|---------|------|------|------|
| `pendingRun.mapAdcode` | orchestrator:104 | `nodes.planner.output.mapAdcode` | |
| `pendingRun.answersSummary` | orchestrator:75 | `nodes.planner.output.answersSummary` | |
| `pendingRun.template` | orchestrator:83 | `nodes.match.output` | 含 layoutId/modules/useTemplate |
| `pendingRun.failCount` | orchestrator:80 | `nodes.repair.output.failCount` | |
| `pendingRun.issueId` | orchestrator:81 | `nodes.repair.output.lastIssueId` | |
| `match.layoutReason` | callTemplateMatch 返回但丢弃 | `nodes.match.output.layoutReason` | **救回** |
| `planner.analysis` | callPlanner 返回但只展示 | `nodes.planner.output.analysis` | **救回** |
| fetch `purpose` | 取数规划产出 | `nodes.fetch.output.usage[].purpose` | **新增 panel 映射** |

### 5.2 产物引用类 -> `nodes[nodeId].refs`

| 现有字段 | 位置 | 归到 | 产物本体去向 |
|---------|------|------|------------|
| `pendingRun.dataBlock`(全文) | orchestrator:89 | `nodes.fetch.refs.dataBlockRef` | `data-block.txt` |
| `pendingRun.inventory`(JSON) | orchestrator:100 | `nodes.planner.refs.inventoryRef` | `inventory.json` |
| `pendingRun.mapPaths`(SVG) | orchestrator:102 | `nodes.planner.refs.mapPathsRef` | `map-paths.json` |
| `ActiveRun.html` | orchestrator:157 | `nodes.coder.refs.htmlRef` | `index.html`（现有） |
| `pendingRun.dataSourcesUsed` | orchestrator:94 | `nodes.fetch.refs.dataUsedRef` | `data-used.json`（现有） |

### 5.3 流程状态类 -> GraphState 顶层

| 现有载体 | 位置 | 归到 |
|---------|------|------|
| `rt.s.stages[].state` | SessionData:135 | `nodes[id].status` |
| `rt.s.stages[].title` | | `definition.nodes[].name` |
| `CREATE_TITLES`/`EDIT_TITLES` | orchestrator:627-631 | `definition` |
| `createStageIds()` | orchestrator:646 | `definition.edges` |
| 当前阶段(隐式 active) | | `current`（显式化） |
| `pendingRun.awaiting` | orchestrator:77 | `awaiting` |

### 5.4 删除的字段（被 GraphState 取代）

| 删除字段 | 位置 | 取代者 |
|---------|------|--------|
| `rt.s.lastDataBlock` | SessionData:148 | Version.memory（isCurrent 版本） |
| `rt.s.lastDataSourcesUsed` | SessionData:150 | Version.memory |
| `pendingRun.dataBlock` | PendingRun:89 | `nodes.fetch.refs.dataBlockRef` + 产物文件 |
| `pendingRun.inventory` | PendingRun:100 | `nodes.planner.refs.inventoryRef` + 产物文件 |
| `pendingRun.mapPaths` | PendingRun:102 | `nodes.planner.refs.mapPathsRef` + 产物文件 |
| `pendingRun.mapAdcode` | PendingRun:104 | `nodes.planner.output.mapAdcode` |
| `pendingRun.template` | PendingRun:83 | `nodes.match.output` |
| `pendingRun.answersSummary` | PendingRun:75 | `nodes.planner.output.answersSummary` |
| `pendingRun.failCount` | PendingRun:80 | `nodes.repair.output.failCount` |
| `pendingRun.issueId` | PendingRun:81 | `nodes.repair.output.lastIssueId` |
| `pendingRun.awaiting` | PendingRun:77 | `graphState.awaiting` |

### 5.5 pendingRun 瘦身后剩余字段

```ts
interface PendingRun {
  kind: 'create' | 'edit'
  text: string          // 用户需求/修改指令
  attachments: string[] // 附件
  clarificationMessageId: string | null  // 澄清卡片关联（UI 用）
}
```

---

## 六、关键代码路径迁移

### 6.1 commitVersion（提交版本）

```
现有：写 HTML + data-used.json
迁移后：
  1. 写 HTML 产物（现有）
  2. 写 data-block.txt / inventory.json / map-paths.json 产物文件（新增）
  3. Memory.commitTo(version, run.graphState)  // freeze 图状态进版本
```

### 6.2 doRollback（版本回退）

```
现有：复制目标版本 HTML + meta 成新节点
迁移后：
  1. 复制 HTML + 产物文件成新节点（现有逻辑扩展）
  2. Memory.restoreTo(run, targetVersion)  // 从目标版本 memory 载入运行态
```

### 6.3 startEditFlow（开始编辑）

```
现有：从 rt.s.lastDataBlock 拷贝到新 run
迁移后：
  1. 从 isCurrent 版本载入 graphState：Memory.loadFrom(currentVersion)
  2. run.graphState = 载入的图状态（复用上轮各节点决策）
```

### 6.4 runCreate / continueCreateToCoding（各阶段）

```
现有：各阶段写 pendingRun 字段
迁移后：各阶段写 run.graphState.nodes[xxx].output / refs
  - planner 完成：nodes.planner.output = {analysis, mapAdcode}
  - 澄清答完：nodes.planner.output.answersSummary = ...
  - 取数完成：nodes.fetch.output = {usage} + refs.dataBlockRef + 写产物文件
  - 模板匹配：nodes.match.output = {layoutId, layoutReason, modules}
  - 编码完成：nodes.coder.refs.htmlRef = ...
```

### 6.5 各 callCoder*（Coder 调用）

```
现有：从 pendingRun 读 dataBlock 等参数
迁移后：
  1. 从 run.graphState 读各节点 output（回灌：planner 分析、模板理由、数据用途映射）
  2. 按 refs 取产物本体（dataBlock 全文、HTML）注入 prompt
```

### 6.6 rebuildActiveRun（重启恢复）

```
现有：按 pendingRun.awaiting 粗粒度反推控制流
迁移后：
  1. 读 isCurrent 版本的 memory（graphState）
  2. 按 graphState.current + graphState.awaiting 重建控制流
  3. 产物按 refs 按需读取
```

### 6.7 emitPlan（阶段初始化）

```
现有：写 rt.s.stages
迁移后：初始化 run.graphState.definition + nodes（全 pending）
```

---

## 七、回灌机制（每个 LLM 任务初始读取）

### 7.1 回灌内容

每个 LLM 调用前，从 `run.graphState` 构造回灌文本块：

```
## 流程记忆（供你理解整体设计意图）
- 需求理解：<planner.output.analysis>
- 澄清确认：<planner.output.answersSummary>
- 布局选择：<match.output.layoutReason>（骨架A/布局U）
- 数据用途映射：<fetch.output.usage：CPU->指标卡、内存->仪表、告警拓扑->中央地图>
- 修复历史：<repair.output.failCount> 次失败

## 本步任务
<具体任务指令>
```

### 7.2 产物按需注入

回灌只含决策摘要（轻量），产物本体按需注入：
- Coder 调用：按 `fetch.refs.dataBlockRef` 取 dataBlock 全文注入
- 修复调用：按 `coder.refs.htmlRef` 取 HTML 全文注入
- 编辑调用：按 `coder.refs.htmlRef` 取当前 HTML + `fetch.refs.dataBlockRef` 取数据

---

## 八、迁移顺序

全量迁移，按依赖关系排序：

```
1. 定义 GraphState 类型 + FlowDefinition（wire.ts / orchestrator.ts）
2. Store 层新增 writeArtifact / readArtifact（store.ts）
3. pendingRun 拆分：决策进 graphState、产物写文件、refs 留定位串
   ← 最大改动，触及所有 pendingRun 读写点
4. ActiveRun 增加 graphState 字段
5. commitVersion / doRollback 加 memory 冻结与恢复
6. startEditFlow 改为从 isCurrent 版本 memory 载入
7. 各 callCoder* 改为从 graphState 读 + 按 ref 取产物
8. rebuildActiveRun 改为读 Version.memory
9. emitPlan 改为初始化 graphState
10. 删除 pendingRun 被取代字段 + rt.s.lastDataBlock 等
11. 回灌机制：各 LLM 调用前构造流程记忆文本块
12. 取数 LLM 增加 panel 输出（datasource.plan.system/user prompt 调整）
13. rt.s.stages 降级为 GraphState 的 UI 投影（或直接由 graphState 派生）
```

---

## 九、需后续确认的点

1. **rt.s.stages 与 GraphState 的关系**：stages 是直接删除（由 graphState.nodes 派生渲染），
   还是保留作为 UI 缓存层？倾向删除，由 graphState 派生，减少双源。
2. **取数 LLM 输出 panel**：需要调整 `datasource.plan.system.md` 让 LLM 多输出 panel 字段，
   并在 `normalizeDataFetchCalls` 中保留。这是直击硬编码的关键，但改变了取数 prompt 契约。
3. **旧 session.json 兼容**：已有 session 文件没有 graphState 字段，需迁移逻辑或容错（graphState 缺失时按旧逻辑兜底）。
4. **回灌文本块**：是否需要一个 `buildMemoryBlock(graphState)` 统一函数，各 callCoder* 调用？
   倾向是，避免每个调用点重复拼装。
