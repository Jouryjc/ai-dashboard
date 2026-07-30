# Loop Engine 设计文档

> 状态：设计稿，待评审
> 核心原则：Loop Engine 是更高层级的抽象，只实现 Loop 循环核心概念。
> 大屏生成是它的一种业务实例，通过声明式接入，不污染引擎层。
> 接入范式借鉴 LangGraph/XState：业务方只声明"步骤+关系"，引擎接管调度并校验。

---

## 一、设计哲学

### 1.1 分层原则

```
┌─ loop-engine（通用循环引擎，零业务知识）─────────────────┐
│  只实现 Loop 核心概念：                                   │
│    - 状态机（节点/边/转移/当前态）                         │
│    - 循环推进（主循环按 edges+guard 自动推进）              │
│    - 挂起/恢复（awaiting 通用，标记由业务定义）             │
│    - 记忆机制（GraphState 的通用形态）                     │
│    - 节点执行器接口（通用，业务实现）                       │
│    - 事件入口（通用，引擎自动决定 start/resume）            │
│    - 声明式接入 + 创建时校验（借鉴 LangGraph compile）      │
│  零业务知识：不知道 planner/fetch/coder，不知道大屏         │
└──────────────────────────────────────────────────────────┘
          ▲ 业务通过声明接入（声明步骤+关系，引擎接管调度）
┌─ dashboard-engine（大屏业务实例）─────────────────────────┐
│  大屏只需声明，不碰引擎内部：                              │
│    - FlowDefinition（planner/match/fetch/coder/check/...）│
│    - 各节点执行器（调 LLM、取数、生成 HTML）               │
│    - 挂起标记值（clarification/problem/llm）               │
│    - onCommit 回调（怎么存版本，引擎决定何时存）            │
│    - 执行器自己持有业务依赖（LLM/MCP/存储）                 │
└──────────────────────────────────────────────────────────┘
```

**铁律：loop-engine 包里不能出现任何大屏业务概念。** planner/fetch/coder/HTML/取数/MCP 都不允许出现。引擎只知道"有节点、有转移、有挂起、有记忆"，节点叫什么、执行什么，全部由业务声明。

### 1.2 接入范式：声明式 + 引擎接管（借鉴业界）

调研业界 5 大框架（LangGraph/XState/Temporal/Airflow/Prefect）的共性：**业务方都不需要理解引擎内部，只需声明"步骤+关系"，框架据此校验完整性并接管调度。**

本设计采用**声明式接入**（借鉴 LangGraph 的声明配置 + compile 校验）：

| 业界范式 | 代表 | 本设计采纳 |
|---------|------|-----------|
| 结构化声明 + 编译期校验 | LangGraph/XState/Airflow | ✅ `createLoop()` 创建时校验 |
| 代码标记 + 运行时拦截 | Temporal/Prefect | ✗ |

业务方只写三类声明：
1. **每个步骤干什么**（NodeExecutor，只关心自己的逻辑）
2. **步骤间关系**（FlowDefinition：节点 + edges + guards）
3. **怎么存版本**（onCommit 回调，引擎决定何时调）

业务方**不碰**：start/restore/resume 的调用时机、事件路由、主循环、转移逻辑。这些全由引擎接管。

### 1.3 关键设计决策（推演结论）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 接入方式 | 声明式 `createLoop()` + 创建时校验 | 业务方不碰引擎内部；借鉴 LangGraph compile |
| 引擎与业务关系 | 引擎接管调度，业务只声明 | 对注入方案的修正：业务不驱动引擎 |
| memory 粒度 | GraphState（完整图状态快照） | 非按 kind/proposition 拆分，避免业务逻辑侵入机制 |
| 回灌策略 | 每个节点执行前读当前图状态 | 不筛选不检索，确定性高 |
| 版本快照存全量 | 全量 | diff 模式为省几百字节引入累计复杂度+脆弱性 |
| memory 不管版本 | 是 Version 的一部分 | 消除平行版本管理，版本号唯一来源是业务版本 |
| 条件转移 | edges 带 guard（借鉴 XState 守卫模式） | 节点不参与路由，guard 独立配置，按声明顺序匹配 |
| 执行器持有依赖 | 是（构造时注入 LLM/MCP/存储） | 引擎不透传业务能力，adapters 删除 |
| 存储层 | 不在引擎包内 | 存储是基础设施，不是 Loop 核心概念 |
| steps 不进 GraphState | 不进 | 动作流水是 UI 旁路，memory 只记产出不记过程 |

---

## 二、问题：现在没有实体在管控 Loop 流程

### 2.1 现状诊断

现有 `orchestrator.ts`（3565 行）是巨型过程式模块，没有"引擎实体"。流程管控靠三样东西拼凑：

**① 数据袋子 `Runtime`**（`orchestrator.ts:178`）：全是状态字段，零行为。

**② 5 个入口函数 + 字符串路由**：`handleSendMessage`/`handleAnswerClarification`/`handleChooseOption` 等，靠 `runStatus`/`optionId` 字符串匹配路由。

**③ 闭包接力（20 处预埋）**：`run.retryLlm = () => continueCreateToCoding(...)`，不可观测、不可持久化、不可扩展。

### 2.2 后果

- 状态机不可见：5 态转移散落在 26 处 `setStatus`
- 闭包接力脆弱：重启靠字符串反推，加阶段靠手改多处
- 记忆无闭环：GraphState 无处安放，决策散落丢失

---

## 三、loop-engine 包：通用循环引擎

### 3.1 包结构

```
loop-engine/                    ← 通用引擎，零业务知识
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                ← 包出口（createLoop 等）
│   ├── engine.ts               ← LoopEngine 实体（核心循环 + 事件入口）
│   ├── graph-state.ts          ← GraphState 类型 + 通用操作
│   ├── definition.ts           ← FlowDefinition / Edge / ResumeTable 类型
│   ├── node-executor.ts        ← NodeExecutor / NodeContext / NodeResult 接口
│   ├── events.ts               ← LoopEvent 通用事件类型
│   └── types.ts                ← 共享类型（全部通用，无业务概念）
└── tests/
    ├── engine.test.ts          ← stub 执行器测状态机
    └── graph-state.test.ts
```

**注意：没有 `nodes/` 目录（节点执行器是业务实现的）、没有 `storage.ts`（存储是基础设施，不在引擎包内）。**

### 3.2 核心类型（全部通用）

```ts
// loop-engine/src/types.ts

/** 节点 id（引擎不认识其含义，是 opaque 字符串） */
export type NodeId = string

/**
 * 挂起标记（引擎不解释其含义）。
 * suspend 时作为 reason 存入 awaiting，重启恢复时匹配 resume 表选恢复点。
 * 值由业务定义（如大屏的 'clarification'/'problem'/'llm'），引擎只匹配不解释。
 */
export type Tag = string

/** 节点产出（业务语义，引擎不解释：可能是决策、结果、信息） */
export interface NodeOutput {
  [key: string]: unknown
}

/** 流程在某一刻的完整图状态 */
export interface GraphState {
  definition: FlowDefinition
  nodes: Record<NodeId, NodeState>
  current: NodeId
  /** 挂起标记；null = 正在推进或已结束 */
  awaiting: Tag | null
}

/**
 * 流程定义：节点 + 带 guard 的边 + guard 实现。
 * 边同时承担"拓扑"和"正向转移"职责（合一，无冗余）。
 * 借鉴 XState 守卫模式：节点只管产出，不参与路由；路由判断（guard）独立配置。
 */
export interface FlowDefinition {
  nodes: Array<{ id: NodeId; name: string }>
  edges: Array<Edge>
  /** guard 实现：路由判断函数，按名引用；与节点执行器分离 */
  guards?: Record<string, (graphState: GraphState) => boolean>
}

/** 一条边：from->to，可选 guard 控制条件转移 */
export interface Edge {
  from: NodeId
  to: NodeId
  /** guard 引用名；缺省 = 无条件边。引擎按声明顺序取首个 guard 为真或无 guard 的边 */
  guard?: string
}

export interface NodeState {
  status: 'pending' | 'active' | 'done' | 'failed'
  output?: NodeOutput
  refs?: Record<string, string>
}
```

### 3.3 恢复表（声明式，替代闭包预埋）

```ts
// loop-engine/src/definition.ts

/**
 * 恢复表：声明每种挂起标记恢复时从哪继续。
 * 只管"逆向恢复"（挂起后跳回某节点），不管正向转移（由 edges+guard 承担）。
 * 恢复点必须静态可查：重启恢复时执行器不在了，只有 awaiting 里存的 Tag，
 * 引擎靠它查这张表重建恢复点。
 */
export interface ResumeTable {
  resume: Record<Tag, ResumePoint>
}

export interface ResumePoint {
  node: NodeId
  before?: (engine: LoopEngine) => void
}
```

### 3.4 节点执行器接口（通用，业务实现）

```ts
// loop-engine/src/node-executor.ts

/**
 * 节点执行器：封装单个节点的业务逻辑。引擎只调 execute()，不关心节点干什么。
 * 执行器自己持有业务依赖（LLM/MCP/存储等），构造时注入，不经引擎中转。
 * 节点是状态变换器，只产出 output，不参与路由（借鉴 LangGraph/XState）。
 */
export interface NodeExecutor {
  execute(ctx: NodeContext): Promise<NodeResult>
}

/** 引擎给执行器的上下文（只有调度相关，无业务能力） */
export interface NodeContext {
  /** 读取图状态（读上游节点 output、当前 current 等） */
  graphState: GraphState
  /** 汇报进度（业务定义如何展示） */
  report: (detail: string) => void
  /** 中止信号（引擎看门狗超时时 abort） */
  signal: AbortSignal
}

/**
 * 执行结果。节点只产出，不参与路由：
 *   - done：返回产出，下一个节点由引擎查 edges+guard 决定
 *   - suspend：返回 reason 存入 awaiting，恢复时查 resume 表
 *   - failed：返回错误，引擎置 blocked 态
 */
export type NodeResult =
  | { kind: 'done'; output?: NodeOutput; refs?: Record<string, string> }
  | { kind: 'suspend'; reason: Tag }
  | { kind: 'failed'; error: Error }
```

### 3.5 事件入口（引擎接管，业务不写路由）

```ts
// loop-engine/src/events.ts

/**
 * 通用事件：业务/适配层把用户操作转成事件传给引擎，引擎自动决定 start/resume。
 * 业务方不实现路由逻辑，只调用 engine.handleEvent(event)。
 */
export type LoopEvent =
  | { kind: 'start'; initialNode: NodeId }          // 启动新流程
  | { kind: 'resume' }                               // 恢复（答题/选卡后）
  | { kind: 'restore'; graphState: GraphState }      // 载入历史快照（回退/重启）
```

引擎收到事件后，**自己**按 graphState.current/awaiting 决定怎么响应：
- `start`：设 current -> 进入主循环
- `resume`：查 resume 表 -> 清 awaiting -> 移 current -> 进主循环
- `restore`：载入 graphState -> 按 awaiting 决定 suspended 还是继续推进

**业务方（含适配层）只负责"判断该发哪种事件"**，不负责"怎么响应"。比如适配层判断"有版本就 restore、没版本就 start"--这是简单条件判断，不是引擎原理。

### 3.6 声明式接入 + 创建时校验（核心，借鉴 LangGraph compile）

```ts
// loop-engine/src/index.ts

/** 业务方声明的一切，传给 createLoop，引擎接管 */
interface LoopConfig {
  /** 流程定义：节点 + edges + guards */
  definition: FlowDefinition
  /** 恢复表 */
  resume: ResumeTable
  /** 各节点执行器（业务实现，自己持有依赖） */
  executors: Record<NodeId, NodeExecutor>
  /** 流程完成时回调（业务实现"怎么存"，引擎决定"何时存"） */
  onCommit?: (graphState: GraphState) => Promise<void>
  /** 节点完成时回调（可选，业务用于 UI 更新/事件发射） */
  onNodeComplete?: (nodeId: NodeId, graphState: GraphState) => void
}

/**
 * 创建 Loop 实例（声明式接入）。创建时校验声明完整性（借鉴 LangGraph compile）：
 *   - edges 引用的 from/to 必须在 nodes 里
 *   - guards 引用名必须在 guards 表里
 *   - executors 必须覆盖所有 nodes
 *   - resume 表的 node 必须在 nodes 里
 * 校验失败直接抛错，不靠业务自觉。
 */
export function createLoop(config: LoopConfig): LoopEngine {
  validateConfig(config)   // 编译期/创建时校验
  return new LoopEngine(config)
}
```

**对比注入方案**：注入方案要求业务理解 start/restore/resume 时机并手动调用；声明式方案业务只声明"步骤+关系+怎么存"，引擎接管调度和时机。新业务 Loop（ALoop/BLoop）只需写声明，不用理解引擎内部。

### 3.7 LoopEngine 实体

```ts
// loop-engine/src/engine.ts

/**
 * LoopEngine：通用循环引擎实例。只实现 Loop 核心概念。
 * 不暴露内部方法（run/selectEdge/setNodeOutput），业务只通过事件入口和回调交互。
 */
export class LoopEngine {
  private graphState: GraphState
  private config: LoopConfig
  private state: EngineState = 'idle'

  constructor(config: LoopConfig) { ... }

  /** 引擎状态（业务映射到展示态） */
  getState(): EngineState { return this.state }

  /** 获取图状态快照（深拷贝，onCommit/回退时用） */
  getGraphState(): GraphState { return structuredClone(this.graphState) }

  /**
   * 事件入口：业务/适配层调用，引擎自动决定如何响应。
   * 业务不直接调 start/resume/restore，只发事件。
   */
  async handleEvent(event: LoopEvent): Promise<void> {
    switch (event.kind) {
      case 'start':
        this.graphState.current = event.initialNode
        this.state = 'running'
        await this.run()
        break
      case 'resume':
        await this.doResume()
        break
      case 'restore':
        this.graphState = structuredClone(event.graphState)
        if (this.graphState.awaiting) {
          this.state = 'suspended'
        } else if (this.graphState.current) {
          this.state = 'running'
          await this.run()
        } else {
          this.state = 'idle'
        }
        break
    }
  }

  private async doResume(): Promise<void> {
    const reason = this.graphState.awaiting
    if (!reason) return
    const point = this.config.resume.resume[reason]
    if (!point) return
    this.graphState.awaiting = null
    point.before?.(this)
    this.graphState.current = point.node
    this.state = 'running'
    await this.run()
  }

  /** 主循环：按 edges+guard 选边推进，直到挂起/失败/完成 */
  private async run(): Promise<void> {
    while (true) {
      const nodeId = this.graphState.current
      const executor = this.config.executors[nodeId]
      if (!executor) break

      this.setNodeStatus(nodeId, 'active')
      const result = await executor.execute(this.makeContext(nodeId))

      switch (result.kind) {
        case 'done':
          this.setNodeOutput(nodeId, result.output, result.refs)
          this.setNodeStatus(nodeId, 'done')
          this.config.onNodeComplete?.(nodeId, this.getGraphState())
          const edge = this.selectEdge(nodeId)
          if (!edge) {
            await this.finish()   // 流程结束 -> 触发 onCommit
            return
          }
          this.graphState.current = edge.to
          break

        case 'suspend':
          this.graphState.awaiting = result.reason
          this.state = 'suspended'
          return

        case 'failed':
          this.setNodeStatus(nodeId, 'failed')
          this.state = 'blocked'
          return
      }
    }
  }

  /** 按 guard 选边（借鉴 XState）：按声明顺序取首个 guard 为真或无 guard 的边 */
  private selectEdge(from: NodeId): Edge | null {
    const candidates = this.graphState.definition.edges.filter(e => e.from === from)
    if (candidates.length === 0) return null
    const guards = this.graphState.definition.guards
    return candidates.find(e => {
      if (!e.guard) return true
      return guards?.[e.guard]?.(this.graphState) ?? false
    }) ?? null
  }

  /** 流程完成：触发 onCommit（引擎决定何时存，业务决定怎么存） */
  private async finish(): Promise<void> {
    this.state = 'idle'
    if (this.config.onCommit) {
      await this.config.onCommit(this.getGraphState())
    }
  }
}

export type EngineState = 'idle' | 'running' | 'suspended' | 'blocked'
```

**引擎内部方法（run/selectEdge/setNodeOutput/finish）全部 private**，业务只能通过：
- `handleEvent(event)` 驱动流程
- `getGraphState()` 读记忆快照
- `onCommit`/`onNodeComplete` 回调被引擎调用

这是架构性约束：业务在节点执行链路上拿不到引擎引用（只有只读 NodeContext），无法绕过转移表。引擎规则靠"声明式接入 + private 内部 + 执行器隔离"保证。

---

## 四、dashboard-engine：大屏业务实例（声明式接入）

> 本节是概念性说明。接入时作为 `server/` 侧的适配层实现。

### 4.1 大屏只需声明（不碰引擎内部）

```ts
// server 侧接入时定义（不在 loop-engine 包内）

/** 1. 声明流程定义：节点 + edges + guards */
const dashboardFlow: FlowDefinition = {
  nodes: [
    { id: 'planner', name: '理解需求' },
    { id: 'match',   name: '匹配模板' },
    { id: 'fetch',   name: '获取数据' },
    { id: 'coder',   name: '编写页面' },
    { id: 'check',   name: '视觉检查' },
    { id: 'repair',  name: '修复问题' },
    { id: 'finish',  name: '生成预览' }
  ],
  edges: [
    { from: 'planner', to: 'match' },
    { from: 'match',   to: 'fetch' },
    { from: 'fetch',   to: 'coder' },
    { from: 'coder',   to: 'check' },
    { from: 'check',   to: 'finish', guard: 'isPassed' },
    { from: 'check',   to: 'repair' },
    { from: 'repair',  to: 'check' }
  ],
  guards: {
    isPassed: (gs) => (gs.nodes.check.output?.issueIds?.length ?? 0) === 0
  }
}

/** 2. 声明恢复表 */
const dashboardResume: ResumeTable = {
  resume: {
    clarification: { node: 'planner', before: clearAwaiting },
    problem:       { node: 'current' },
    llm:           { node: 'current' }
  }
}

/** 3. 声明各节点执行器（自己持有 LLM/MCP/存储依赖） */
const executors: Record<string, NodeExecutor> = {
  planner: new PlannerExecutor(llm),
  match:   new MatchExecutor(llm, templates),
  fetch:   new FetchExecutor(llm, mcp, sqliteStorage),
  coder:   new CoderExecutor(llm),
  check:   new CheckExecutor(llm),
  repair:  new RepairExecutor(llm),
  finish:  new FinishExecutor()   // finish 只产出，commit 由引擎触发 onCommit
}

/** 4. 声明 onCommit（怎么存版本，引擎决定何时调） */
async function onCommit(graphState: GraphState): Promise<void> {
  await sqliteStorage.saveVersion(dashId, {
    graphState,
    html: graphState.nodes.coder.refs?.htmlRef,
    dataBlock: graphState.nodes.fetch.refs?.dataBlockRef
  })
}

/** 5. 创建 Loop（一步，引擎接管调度 + 创建时校验） */
const engine = createLoop({
  definition: dashboardFlow,
  resume: dashboardResume,
  executors,
  onCommit,
  onNodeComplete: (nodeId, gs) => emitSseEvent(nodeId, gs)  // 可选：UI 更新
})
```

### 4.2 适配层：用户操作 -> 事件

server 侧写一个薄适配层，把用户操作转成 LoopEvent，引擎自动响应。适配层是基础设施（只写一次），不是每个业务 Loop 都写：

```ts
// server 侧适配层（薄，只判断事件类型，不碰引擎内部）

export function handleSendMessage(dashId, text, attachments) {
  const engine = getOrCreateEngine(dashId)
  const hasVersion = await sqliteStorage.hasVersion(dashId)
  if (!hasVersion) {
    // 新建：启动流程
    engine.handleEvent({ kind: 'start', initialNode: 'planner' })
  } else {
    // 编辑：载入当前版本记忆后继续
    const gs = await sqliteStorage.loadGraphState(dashId)
    engine.handleEvent({ kind: 'restore', graphState: gs })
  }
}

export function handleAnswerClarification(dashId, ...) {
  getOrCreateEngine(dashId).handleEvent({ kind: 'resume' })
}

export function handleChooseOption(dashId, optionId) {
  // optionId 的业务语义在适配层处理（如 opt-rollback 触发回退）
  // 然后发 resume 事件让引擎继续
  getOrCreateEngine(dashId).handleEvent({ kind: 'resume' })
}

export function handleRollback(dashId, versionId) {
  const engine = getOrCreateEngine(dashId)
  const gs = await sqliteStorage.loadGraphState(dashId, versionId)
  engine.handleEvent({ kind: 'restore', graphState: gs })
}
```

**适配层只做两件事**：判断发哪种事件（start/restore/resume）+ 处理 optionId 的业务语义（如 opt-rollback 单独处理）。不碰引擎的调度逻辑。

### 4.3 执行器自己持有业务依赖

```ts
/** fetch 执行器：构造时持有 LLM/MCP/存储，不经引擎中转 */
class FetchExecutor implements NodeExecutor {
  constructor(private llm: LlmAdapter, private mcp: McpAdapter, private storage: DashboardStorage) {}

  async execute(ctx: NodeContext): Promise<NodeResult> {
    const catalog = await this.mcp.listTools(...)
    const calls = await planFetch(this.llm, ctx.graphState, catalog, ctx.signal)
    const results = await executeCalls(this.mcp, calls)
    const ref = await this.storage.saveArtifact('data_block', buildDataBlock(results))
    return {
      kind: 'done',
      output: { usage: calls.map(c => ({ purpose: c.purpose, panel: c.panel })), summary: '...' },
      refs: { dataBlockRef: ref }
    }
  }
}
```

执行器只读 `ctx.graphState`（上游 output）、返回 NodeResult（产出）。拿不到引擎引用，调不到 run/selectEdge。依赖（LLM/MCP/存储）构造时自己持有。

---

## 五、记忆层（GraphState）

### 5.1 通用 GraphState（引擎定义）

见 3.2 节。引擎只定义结构，不认识 output 里装什么、awaiting 是什么值。

### 5.2 大屏业务的填充（业务声明）

```ts
// planner 节点产出
{ analysis: string, mapAdcode: string, answersSummary: string }
// match 节点产出
{ layoutId: string, layoutReason: string, modules: MatchModule[], useTemplate: boolean }
// fetch 节点产出
{ usage: Array<{ purpose: string, panel: string }>, summary: string }
```

业务约定，引擎的 `NodeOutput = { [key: string]: unknown }` 只存不解释。

### 5.3 记忆与版本

- **commit**：引擎流程完成时自动调 `onCommit(graphState)`，业务在回调里把记忆存进 SQLite
- **回退/编辑**：适配层从 SQLite 读出 graphState，发 `restore` 事件，引擎载入继续
- **重启恢复**：适配层读当前版本 graphState，发 `restore` 事件，引擎按 current/awaiting 重建

引擎只提供 `getGraphState()`（导出快照）和 `handleEvent({kind:'restore'})`（载入快照），都是内存操作。怎么存进 SQLite 是业务（onCommit）的事。

---

## 六、产物层与存储

### 6.1 存储不在引擎包内

存储是基础设施，不是 Loop 核心概念。引擎只管 GraphState 的内存态（get/restore），不认识 SQLite/文件/任何存储介质。

### 6.2 业务侧存储（SQLite）

业务侧（server）自己实现存储。表结构由业务声明（声明式表结构 + TS 类型派生），引擎不参与：

```ts
// server 侧：声明大屏的表结构，TS 类型从声明派生
const dashboardStorage = defineStorage({
  tables: [
    { name: 'dashboards', fields: [...] },
    { name: 'versions', fields: [..., { name: 'graph_state', type: 'json' }, { name: 'html', type: 'text' }] },
    { name: 'messages', fields: [...] },
    // ...
  ]
})
```

执行器构造时注入存储实例（如 `new FetchExecutor(llm, mcp, dashboardStorage)`），直接调存储存产物。引擎完全不感知存储。

### 6.3 产物与记忆分离

- **记忆**（GraphState）：引擎管内存态，业务管持久化（onCommit 存进 versions.graph_state）
- **产物**（HTML/dataBlock/inventory）：业务执行器自己存（调注入的存储），graphState 里只存 ref（指向产物的定位串）

---

## 七、与现有 orchestrator 的对照

| orchestrator 现有 | 归属 | 替代 |
|------------------|------|------|
| `Runtime`（数据袋子） | 引擎 | `LoopEngine` 实例（数据+行为） |
| `handleSendMessage` switch(runStatus) | 适配层 | 适配层判断事件 + `engine.handleEvent` |
| `handleChooseOption` 11 个 case | 适配层 | 适配层处理 optionId + `handleEvent({kind:'resume'})` |
| `runCreate`->`continueCreateToCoding`->`checkRepairAndFinish` 链 | 引擎 | `engine.run()` 主循环 + edges+guard |
| 20 处 `run.retryLlm/proceed/retryRepair` | 引擎 | `ResumeTable.resume` 声明式恢复点 |
| `rebuildActiveRun` 字符串反推 | 引擎 | `handleEvent({kind:'restore'})` 从 memory 确定性恢复 |
| `emitPlan` 写 stages | 引擎 | `createLoop` 初始化 graphState |
| `commitVersion` 写产物 | 业务 | `onCommit` 回调（引擎触发，业务存） |
| `doRollback` 复制 HTML | 适配层 | 适配层读 memory + `handleEvent({kind:'restore'})` |

**分界线**：调度机制（主循环/转移/挂起恢复/记忆存取/事件路由）归引擎；业务逻辑（节点干什么、产物怎么存、optionId 语义）归业务/适配层。

---

## 八、实现顺序

### 阶段一：loop-engine 包（通用引擎，不碰源码）

```
1. 建包结构（package.json / tsconfig / 目录）
2. types.ts：GraphState / NodeState / NodeOutput / FlowDefinition / Edge / Tag 等通用类型
3. definition.ts：ResumeTable / ResumePoint 类型
4. node-executor.ts：NodeExecutor / NodeContext / NodeResult 接口
5. events.ts：LoopEvent 通用事件类型
6. graph-state.ts：GraphState 操作（创建/读/写 output/转移/挂起）
7. engine.ts：LoopEngine 实体（主循环 + handleEvent + getGraphState）
8. index.ts：createLoop + validateConfig（创建时校验）
9. tests/：stub 执行器 + 单元测试（状态机/edges选边/挂起恢复/记忆存取/事件路由/校验）
```

### 阶段二：dashboard-engine 接入（server 侧，不改 orchestrator 核心）

```
10. 声明大屏 FlowDefinition（edges+guard+guards）+ ResumeTable
11. 实现各节点执行器（planner/fetch/coder/check/repair/finish，自己持有依赖）
12. 实现 onCommit（存版本进 SQLite）
13. 实现适配层（用户操作 -> LoopEvent）
14. 实现存储层（SQLite 表结构声明 + 读写）
15. orchestrator 入口改为委托适配层
16. 跑 smoke 测试验证行为一致
17. 逐步删除 orchestrator 被取代的逻辑
```

---

## 九、待确认的点

1. **看门狗（20 分钟超时 + 拆分）**：引擎的 execute 内置 AbortController + 超时，通过 `ctx.signal` 传给执行器。拆分是业务概念，留在 coder 执行器内。倾向：引擎管超时中止，执行器响应 abort 决定恢复策略。

2. **SSE 事件发射**：通过 `onNodeComplete` 回调触发，业务在回调里发 SSE。引擎不发射业务事件，只回调通知节点完成。事件粒度由业务定。

3. **排队消息**：现在生成中发的消息排队，Run 结束合并触发 edit。倾向：排队是业务概念，适配层在 `handleEvent({kind:'start'})` 时判断 running 态入队，idle 时触发。

4. **人工协助流（assisting 态）**：UI 流程非 Loop 核心逻辑，留在 server 侧。引擎只管 assisting 状态的进入/退出。

5. **GraphState-memory-design.md 的关系**：该文档定义记忆层数据结构（大屏视角），本文档定义通用引擎 + 声明式接入。记忆层通用部分在本文档 3.2 节；大屏填充在第四节。两文档互补。

---

## 十、业界参考库调研

设计前调研了 5 个主流 Loop/Workflow 引擎框架，重点考察"业务方如何低门槛接入"和"框架如何约束业务遵循契约"。结论：**所有框架的业务方都不需要理解引擎内部，只需声明"步骤+关系"，框架据此校验并接管调度。**

### 10.1 调研总览

| 框架 | 接入范式 | 业务方写什么 | 约束机制 | 需理解引擎内部? |
|------|---------|-------------|---------|--------------|
| **LangGraph** | 声明配置 + 命令式组合 | State + 节点函数 + 边 | 编译期 `compile()` 校验 | 否，只需"步骤+关系" |
| **Temporal** | 装饰类(伪继承) | `@workflow.defn` 类 + `@workflow.run` 方法 | 运行时(Worker 沙箱)强校验 | 需理解"确定性沙箱"边界 |
| **XState** | 声明配置 | `createMachine(config)` 对象 | 结构约束(TS 类型) | 否，只需"状态+事件+转移" |
| **Airflow** | 实例化 Operator + DAG 上下文 | Operator 实例 + `>>` 依赖 | 解析期 DAG 校验 | 否，只需"任务+依赖" |
| **Prefect** | 装饰函数 | `@flow`/`@task` 纯函数 | 运行时拦截 | 否，几乎零认知 |

### 10.2 接入体验从轻到重

Prefect（装饰函数）< XState（声明对象）< Airflow（实例化+上下文）< LangGraph（命令式拼装+compile）< Temporal（装饰类+确定性沙箱）

### 10.3 约束机制分三档

- **编译期/解析期校验**（最强，错得最早）：LangGraph `compile()`、Airflow DAG 解析、XState 的 TS 类型
- **运行时沙箱校验**（最硬，但晚暴露）：Temporal 确定性约束
- **运行时拦截/无校验**（最松）：Prefect 装饰器

### 10.4 两类"强制契约"思路

1. **结构化声明**（LangGraph/XState/Airflow）：框架要求业务方显式声明"步骤+关系"，框架据此静态校验完整性（漏边、悬空节点、循环）。业务方认知 = "画图"。
2. **代码标记**（Temporal/Prefect）：框架用装饰器把普通代码纳入托管，校验靠运行时。

### 10.5 本设计的借鉴

采用**结构化声明 + 编译期校验**（LangGraph/XState 路线）：

| 借鉴点 | 来源 | 本设计落地 |
|--------|------|-----------|
| 声明式接入 + 创建时校验 | LangGraph `compile()` | `createLoop()` + `validateConfig()` |
| 条件转移用 guard | XState 守卫模式 | `Edge.guard` + `FlowDefinition.guards` |
| 节点不参与路由 | LangGraph/XState 共性 | `NodeResult.done` 不含路由信息，路由由 guard 判断 |
| 节点是状态变换器 | LangGraph/XState 共性 | 执行器只产出 output，引擎查 edges 选边 |

不采用 Temporal 的命令式（放弃静态图）和 Prefect 的装饰函数（约束太松），因为本项目需要"回退/恢复"依赖完整的图状态快照，声明式图定义是前提。

### 10.6 各框架接入代码示例

#### LangGraph -- 声明配置 + compile 校验

```python
from langgraph.graph import StateGraph, START, END

def node_b(state): ...      # 节点只改 state
def route_after_c(state):   # 路由函数（独立于节点）
    return "d" if state["passed"] else "b"

g = StateGraph(State)
g.add_node("b", node_b)
g.add_node("c", node_c)
g.add_edge("b", "c")
g.add_conditional_edges("c", route_after_c, {"d": "d", "b": "b"})  # 显式列出合法路由目标
agent = g.compile()          # ← 编译期校验：边引用的节点存在、路由目标合法
```

#### XState -- 声明配置 + guard 守卫

```ts
const machine = createMachine({
  initial: 'b',
  states: {
    c: {
      on: { CHECKED: [
        { guard: 'isPassed', target: 'd' },   // guard 引用名
        { target: 'b' }                        // 兜底
      ]}
    }
  }
}, {
  guards: { isPassed: ({ context }) => context.passed }  // 实现单独配
});
```

#### Temporal -- 装饰类 + 确定性沙箱

```python
@workflow.defn(name="FixLoop")
class FixLoopWorkflow:           # 不继承基类
    @workflow.run
    async def run(self, item_id):  # 唯一入口
        while not passed:
            await workflow.execute_activity(act_b, item_id)  # 副作用必须走 activity
            passed = await workflow.execute_activity(act_c, item_id)
```

#### Airflow -- 实例化 Operator + DAG 上下文

```python
with DAG("fix_loop", ...) as dag:
    t1 = BashOperator(task_id="check", bash_command="...")
    t2 = BashOperator(task_id="fix", bash_command="...")
    t1 >> t2   # >> 声明依赖，解析期校验无环
```

#### Prefect -- 装饰函数（最低门槛）

```python
@flow
def fix_loop(item_id):
    passed = False
    while not passed:
        do_b(item_id)
        passed = check(item_id)
    do_d(item_id)
```

### 10.7 调研来源

- LangGraph: `docs.langchain.com/oss/python/langgraph/quickstart`
- XState: `stately.ai/docs/guards`
- Temporal: `docs.temporal.io/develop/python/workflows/basics`
- Airflow: `airflow.apache.org/docs/apache-airflow/stable/tutorial/fundamentals.html`
- Prefect: `docs.prefect.io/v3/how-to-guides/workflows/write-and-run`
