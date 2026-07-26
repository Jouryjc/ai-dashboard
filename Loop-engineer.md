# Loop Engineering 流程梳理

本文盘点 AI 大屏工作台中体现 Loop Engineering（闭环工程）的全部流程。核心思想：**感知 → 决策 → 行动 → 验证 → 失败回到环路**，且所有自动环路遵守同一原则——**自动循环必有预算，预算耗尽必升级人工，人工修完必交还环路**。

---

## 一、核心生成-验证-修复闭环（最典型的 Agent Loop）

`checkRepairAndFinish`（`server/src/orchestrator.ts:2168`）：

```
Coder 生成 HTML
  → 确定性硬校验 validateHtml（完整性 / 外部资源 / 长度）
  → LLM 审查（截图对比 或 文本审查）
  → 问题合并去重，每个问题一张 Issue 卡（≤3 张）
  → callCoderRepair 修复
  → 修复后复跑硬校验 + 重新截图复审   ← 环路的"再验证"
  → 通过 → 提交版本；没通过 → 下一轮修复（预算 ≤2 次）
  → 预算用完 → 升级问题卡片，进入人在环
```

关键设计：

- **双通道验证降级链**：截图浏览器 + vision 可用 → 真截图对比验收（`callShotReview`，含参考图）；不可用 → 文本结构审查（`callVisualReview`）；审查也失败 → 硬校验兜底（`orchestrator.ts:2178-2228`）——环路永不因工具缺失而断裂
- **修复前后真截图落盘**（`/shots/...`），让"修没修好"对人和模型都可观测（`orchestrator.ts:2297-2331`）
- **修复预算制**：`issues[0].attempt >= 2` 即停止自动循环，防死循环（`orchestrator.ts:2339`）

## 二、看门狗 + 自动拆分环路（超时自愈）

`armAgentWatchdog` / `splitCodingFlow`（`orchestrator.ts:727-978`）：

- 每个 LLM 步骤布防 20 分钟看门狗（`AGENT_STEP_MAX_MS` 可调），到点 abort 当前调用
- **编码类超时 → 自动拆环**：骨架生成 → 逐面板生成（每步独立小 LLM 调用、各自布防看门狗）→ 拼装 → 接力回检查修复闭环
- **防无限拆分**：`splitUsed` 标记，拆分后再超时不二次拆分，升级超时卡片（`orchestrator.ts:757`）
- 看门狗接管身份用 AbortController 引用比对（`watchdogAborted === ctl`），解决"旧调用 catch 晚落地踩新流程"的环路竞态（`orchestrator.ts:149`）

## 三、失败计数 + 推荐规则表（自动 → 半自动 → 人工的升级环）

`buildProblemOptions` 确定性规则表（`orchestrator.ts:335-472`）：

| 场景 | 环路行为 |
|---|---|
| 首次失败 | ★重试 + **10 秒倒计时自动执行**（`armAutoExec`，`orchestrator.ts:1583`） |
| 失败 3 次 | ★呼叫人工（自动环路主动退出） |
| 数据源不可用 | ★改用演示数据继续（换轨道而不是卡死） |
| 高风险 | 永不自动执行，必须人工 |

`failCount` / `issue.attempt` 随 `pendingRun` 落盘，重启后升级计数不丢。

## 四、人在环（Human-in-the-Loop）的五个卡口

1. **澄清环**：Planner 判断需求模糊 → 澄清卡片（≤3 题、恰一个 ★推荐）→ `awaiting_clarification` 挂起 → 答题 / 自由输入兜底 → 答案汇总注入后续 prompt（`orchestrator.ts:1869-1904`、`2596-2644`）
2. **问题卡片 / 卡点**：`blocked` 态，对话区卡片与右栏行动区渲染同一组 option id
3. **模板无匹配确认卡**：★自定义生成 / 用最接近模板（`orchestrator.ts:1667`）
4. **数据源卡点卡**：演示数据继续 / 重试取数 / 人工（`orchestrator.ts:1730`）
5. **人工协助环**：`assisting` 态模拟客服流水 → 确定性清洗 `sanitizeHtml` 修好 → **交还控制权自动续跑**（`orchestrator.ts:2881-2949`）——人工不是终点而是环路的一段

## 五、感知-决策环（能力探测协商）

`getCapability` / `gw.probe`（`orchestrator.ts:517-550`、`gateway.ts:294-408`）：

- 任务启动前真实探测：最小 chat 验证连通 + 1×1 像素 PNG 探针验证 vision
- 探测结果决定走哪条环路：带图 / 不带图、精读 / 不精读、截图审查 / 文本审查
- 设置变更 → 缓存失效 → 重新探测，形成"环境变了环路自适应"的感知闭环
- 探针自身也带容错环：stream-only 端点自动换流式重试、空内容 ≠ 不支持

## 六、网关层传输重试环

`gateway.ts`：

- 网络错误 / 5xx 重试 1 次，4xx 不重试（`gateway.ts:116-179`）
- 思考型模型锁定 temperature → 自动去参重试且不占重试额度（`gateway.ts:144-150`）
- 流式请求被服务方忽略 → 自动退化普通 JSON 响应（`gateway.ts:237-244`）
- `extractJson` / `extractHtml` 容错提取（去围栏、截取首尾括号）——输出层的"软校验环"

## 七、MCP 取数环

`fetchDataForCreate`（`orchestrator.ts:1914-2012`）：

```
listTools（带缓存）→ 取数规划 LLM → 白名单确定性过滤（非法调用丢弃、≤3 条）
→ 逐个 callTool（15s 超时 + 连接类失败重试 1 次，mcp.ts:218）
→ 单个失败不致命继续；全部失败 → 数据源卡点卡
→ dataBlock 快照落盘 → 编辑 / 修复 / 拆分一律复用快照，不重取
```

## 八、复刻模式的精读-备料-生成环

- 参考图裁 5 块局部放大 → vision 精读内容清单（`orchestrator.ts:1827-1864`）
- 精读失败不阻塞：`inventory=null` 按文字描述继续（环路的优雅降级）
- 地图备料子环：adcode → GeoJSON 下载 → 投影抽稀成 SVG 路径 → 内联给 Coder；任何一步失败 → 大白话告知 + 按描述画（`orchestrator.ts:2103-2124`）

## 九、排队-合并环

`drainQueue`（`orchestrator.ts:2462-2475`）：生成中发的消息排队（`queued:true`），Run 结束合并成一条触发新一轮 edit loop——多轮对话本身构成一个大环。

## 十、持久化-恢复环

- **事件溯源**：所有事件先落 `events/<id>.jsonl`（seq 递增）再广播，重启恢复 seq，`Last-Event-ID` 断线补发（`store.ts:114-135`、`routes.ts:281-289`）
- **pendingRun 续跑**：任务描述（含 dataBlock、inventory、failCount）落盘，重启后 `rebuildActiveRun` 最大努力重建重试闭包（`orchestrator.ts:2810-2831`）
- SSE 15s 心跳保活

## 十一、观测性反馈环（让人看得见环路）

"人在环"能成立的前提（详见 `AI_DASHBOARD_OBSERVABILITY.md`）：

- `llmProgress`：600ms 节流汇报生成字数，>90s 附加安抚文案，杜绝静默转圈（`orchestrator.ts:692`）
- `makeLivePreview`：边生成边把部分 HTML 写 building 预览页，每 ~3s 推一次，页面"逐步长出来"（`orchestrator.ts:709`）
- `AgentStep` 动作流：文案写入时固化大白话，新一轮首条带 `reset=true`；`closeOrphanSteps` 兜底关闭永远转圈的孤儿动作（`orchestrator.ts:278`）
- 发布 = 5 秒审批模拟环（`orchestrator.ts:2865`）

---

## 总结

Loop Engineering 在本项目落到四个层次：

| 层次 | 内容 |
|---|---|
| **行动层** | 生成 → 校验 → 修复 → 复检 |
| **自愈层** | 重试 / 拆分 / 降级链，每层都有预算和熔断 |
| **决策层** | 能力探测 + 推荐规则表决定自动还是交人 |
| **恢复层** | 事件溯源 + pendingRun 续跑，保证环路跨重启不断 |
