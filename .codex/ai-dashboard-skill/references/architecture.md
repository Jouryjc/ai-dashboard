# 当前架构与事实源

## 目录与职责

| 区域 | 职责 | 关键入口 |
| --- | --- | --- |
| `client/` | Electron + Vue 3 工作台、Pinia 状态、HTTP/SSE 与 Mock 双实现 | `src/types/index.ts`、`src/api/client.ts`、`src/stores/` |
| `server/` | Express、模型网关、流程编排、持久化、预览、导出和发布 | `src/orchestrator.ts`、`src/gateway.ts`、`src/store.ts` |
| `loop-engine/` | 通用声明式图执行、guard、挂起恢复、JSON 检查点 | `src/engine.ts`、`src/graph-state.ts` |
| `server/src/artifacts/` | 产物 Adapter、生成、构建、校验和导出 | `registry.ts`、`types.ts` |
| `server/skills/` | 生成运行时使用的受控技能 | `idux-cli/`、`idux-style/` |
| `.codex/` | 维护仓库时供编码 Agent 使用的工程技能 | `ai-dashboard-skill/` |

## 客户端运行模型

客户端技术栈为 Electron + Vue 3 `<script setup>` + TypeScript + Pinia + Vue Router hash 模式 + Tailwind CSS v4 + Vite。

`client/src/api/index.ts` 根据 `VITE_API_BASE` 选择实现：

- 设置时使用 `api/http/`，命令走 HTTP、状态通过 SSE 返回。
- 未设置时使用 `api/mock/` 剧本引擎，store 和组件不需要改动。

四个主要 store：

- `dashboards`：首页项目列表。
- `session`：预览、阶段、步骤、Issue、版本和顶栏状态。
- `chat`：用户、Agent、澄清、问题和系统消息。
- `settings`：模型、角色模型和连接探测。

API 方法主要负责发指令，结果通过事件更新。SSE 使用 append-only seq，断线后通过 `Last-Event-ID` 补发。执行面板由 Stage、AgentStep、Issue 和 blocker 组成；新一轮第一条 step 使用 `reset=true` 清除旧轨迹。动作文案由服务端或 Mock 直接写成中文大白话，客户端不二次翻译。

用户状态徽标固定为 `生成中 / 已完成 / 已发布 / 需要处理`，以 `DASHBOARD_STATUS_LABEL` 为准。预览通过 iframe 加载 `session.previewUrl`；dashboard 按固定画布等比缩放，business-app 按目标桌面视口验收。

## 服务端运行模型

- `gateway.ts`：OpenAI 兼容 chat completions、角色模型解析、超时/重试、聊天与 1px 图片能力探测、JSON/HTML 提取和 provider 错误中文映射。
- `orchestrator.ts`：Run 五态、两类产物编排、排队、问题卡片、看门狗、修复、版本、回退、发布和人工协助。
- `routes.ts`、`index.ts`：REST、SSE、15 秒心跳、CORS 和静态资源入口。
- `store.ts`：JSON 会话、JSONL 事件、预览源码/产物、封面和修复截图。
- `preview.ts`：独立预览 origin，默认端口 8788，用于隔离生成产物。

服务端默认端口为 8787，预览服务默认端口为 8788。持久化根目录默认是 `server/data/`，可由 `DATA_DIR` 覆盖，包括：

```text
dashboards.json
settings.json
data-sources.json
publish-config.json
sessions/<id>.json
events/<id>.jsonl
workspaces/<project>/<revision>/...
previews/<project>/<revision>/...
covers/<project>.png
shots/<project>/...
```

这些文件是本地运行数据而非源码，不得提交。

## 事实源优先级

1. 当前代码、类型和自动化测试。
2. `API_CONTRACT_HTTP.md` 与 `client/src/types/index.ts`、`client/src/api/client.ts` 的同步契约。
3. `docs/multi-artifact-architecture.md`、`docs/loop-engine-design.md` 与 `docs/GraphState-memory-design.md`。
4. `AI_DASHBOARD_CLIENT_UX.md`、`AI_DASHBOARD_OBSERVABILITY.md`、`client/CONTRACT.md`。
5. README、历史计划和旧实现说明。

发现文档与代码不一致时，先用测试确认实际行为，再在同一改动中更新事实文档。不要继续传播“只有 dashboard”或“没有 Loop 单测”等过时结论。

历史文档使用注意事项：

- `client/CONTRACT.md` 的 store 数据流、设计令牌和组件边界仍有效；其中“7 个并行 agent 文件所有权”和旧绝对路径只描述早期协作阶段，除非当前任务重新分配所有权，否则不要把它当成永久禁改清单。
- `docs/loop-engine-design.md` 中 SQLite 等内容包含概念性演进方案；当前服务端事实以 `server/src/store.ts` 的 JSON/JSONL 持久化和实际 LoopEngine 代码为准。
- 根 README 与贡献指南若仍声称没有单元测试，应以 `loop-engine/tests/` 和当前 package scripts 为准并顺手修正文档。

## 双产物模型

`Project` 创建时确定 `artifactKind`：

- `dashboard`：固定画布、自包含 HTML、指标与可视化优先。
- `business-app`：Vue + Vite + IDux 多文件工程，支持多模块业务任务和持续增量演进。

两类产物共用 Project、Revision、Manifest、ValidationReport、预览、回退、导出和发布抽象；各自通过 Artifact Adapter 声明目标配置和门禁。

成功 Revision 是不可变提交。生成中的草稿、失败候选与已提交版本必须分离；回退复制完整产物，不能修改历史节点。

## business-app 分层

```text
用户请求 / 参考图
  -> Requirement Analyzer
  -> RequirementContract（clarifying | ready）
  -> Blueprint Planner
  -> ApplicationBlueprint + ChangePlan
  -> idux-enterprise-design B 端模式 + idux-cli 组件证据 + idux-style 视觉资产
  -> Schema Renderer / 受控项目草稿
  -> 静态准入 + Vite 构建
  -> 双视口任务场景 + 视觉复核 + 网络审计
  -> Repair Loop
  -> 通过后原子提交 Revision
```

核心目录：

- `domain/`：可序列化领域模型和跨引用校验。
- `requirements/`：确定性优先的逐问需求分析和敏感信息脱敏。
- `planning/`：确定性安全基线、模型增强、目标模块边界检查。
- `generation/`：B 端模式、IDux 组件/样式证据与 Schema 驱动运行时。
- `adapter.ts`：文件、契约、依赖、证据和蓝图完整性门禁。
- `builder.ts`：路径、体积、导入、API、URL、凭据检查及受控构建。
- `validator.ts`：双视口浏览器审计和端到端场景执行。
- `reviewer.ts`、`repairer.ts`、`coder.ts`：视觉复核和有界修复。

## LoopEngine 边界

LoopEngine 只认识节点、边、guard、状态、输出引用、挂起标签和恢复事件，不认识 dashboard 或 business-app。

- 节点执行器只读 `NodeContext.graphState`，通过 `NodeResult` 返回产出。
- 路由由 `FlowDefinition.edges + guards` 决定，节点不得选择下一跳。
- `onCommit` 只在流程真正完成时触发。
- `GraphCheckpoint` 不保存包含函数的 FlowDefinition；恢复时绑定服务端可信定义。
- `flowVersion` 在拓扑或检查点语义变化时递增。
- business-app 修复耗尽由 Loop 的显式终止状态持久化，不按已执行策略数量推断；同一 `flowVersion` 对相同需求最多重新生成一次，避免恢复卡片形成无限循环。
- 恢复前校验节点集合、当前指针、状态、output、refs 和 awaiting。

## 状态与事件

工作台 Run 五态为 `idle / generating / awaiting_clarification / blocked / assisting`。客户端通过 HTTP 发命令，通过 SSE 接收消息、阶段、步骤、图、预览、版本和卡点事件；`Last-Event-ID` 支持补发。

客户端数据流固定为：

```text
组件 -> store action -> ClientApi -> HTTP/Mock
SSE/Mock event -> store -> 组件
```

禁止组件绕过 store 直接访问 API。问题卡片与右栏 blocker 必须消费相同 option id，避免两个入口状态分叉。

## 参考图边界

- 先探测模型视觉能力，不支持时明确失败。
- 原图可按受控区域裁剪后分析，结果必须规范化为结构化证据。
- 图片不决定业务实体、权限、数据连接或工作流含义。
- 证据保存图片摘要和分析摘要，不把原图写入生成证据。
- 参考图产物必须额外完成视觉对比复核，不能把“模型不可用”当作通过。

## 当前已知限制

- 服务重启时残留的 `generating` 和 `assisting` 内存任务会回落为可输入状态；business-app 的澄清检查点可以恢复，但并非所有旧 dashboard 内存闭包都能跨进程续跑。
- 模型 API Key 仍以明文保存在本地 `server/data/settings.json`。当前仅适合单用户本地开发；生产必须改用密钥引用、Vault 或加密存储。
- dashboard 的部分人工协助仍是确定性清洗兜底，stall 类型卡点尚未形成完整独立机制。
- dashboard 在没有视觉模型或浏览器时存在降级路径；参考图驱动的 business-app 不允许把缺少视觉复核降级为通过。
- `stitch-reference/` 保存早期工作台视觉基准 HTML 与截图；修改首页或工作台整体布局时应对照，但以当前 UX 文档和产品能力为最终约束。
