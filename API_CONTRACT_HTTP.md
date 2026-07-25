# AI 大屏工作台 · HTTP API 契约（服务端 ⇄ 客户端）

> 唯一事实源。服务端（server/）与客户端 HTTP 适配层（client/src/api/http/）都以此为准。
> 业务类型（Dashboard / ChatMessage / Stage / Issue / Blocker / Version / AssistSession / RunStatus / ProbeResult / ModelSettings / ClarificationAnswer / PreviewResolution）定义见 `client/src/types/index.ts`，事件载荷见 `client/src/api/client.ts` 的 `ClientEventMap` 与 `WorkbenchSnapshot`，**两边原样引用，不改字段名**。

Base URL 示例：`http://localhost:8787`。所有 JSON。CORS：开发期 `Access-Control-Allow-Origin: *`。

## REST

| 方法 | 路径 | 请求体 → 响应 | 对应 ClientApi |
|---|---|---|---|
| GET | `/api/v1/dashboards` | → `Dashboard[]` | listDashboards |
| POST | `/api/v1/dashboards` | `{name}` → `Dashboard` | createDashboard |
| POST | `/api/v1/dashboards/:id/rename` | `{name}` → `Dashboard` | renameDashboard |
| DELETE | `/api/v1/dashboards/:id` | → 204 | deleteDashboard |
| POST | `/api/v1/dashboards/:id/enter` | → `WorkbenchSnapshot` | enterDashboard |
| POST | `/api/v1/dashboards/:id/leave` | → 204（仅断开该客户端的 SSE，任务继续跑） | leaveDashboard |
| POST | `/api/v1/dashboards/:id/messages` | `{text, attachments?: string[]}` → 202。attachments 为 dataURL（客户端已把 blob: 转好）或 http(s) URL | sendMessage |
| POST | `/api/v1/dashboards/:id/messages/:messageId/answers` | `{answers: ClarificationAnswer[]}` → 202 | answerClarification |
| POST | `/api/v1/dashboards/:id/options/:optionId` | → 202 | chooseOption |
| POST | `/api/v1/dashboards/:id/auto-exec/cancel` | → 204 | cancelAutoExec |
| GET | `/api/v1/dashboards/:id/versions` | → `Version[]` | listVersions |
| POST | `/api/v1/dashboards/:id/versions/:versionId/preview` | → 204（发 previewReady 事件指向该版本） | previewVersion |
| POST | `/api/v1/dashboards/:id/versions/current` | → 204（回到当前版本） | backToCurrentVersion |
| POST | `/api/v1/dashboards/:id/versions/:versionId/rollback` | → 202（生成新节点） | rollback |
| POST | `/api/v1/dashboards/:id/preview-resolution` | `{resolution: PreviewResolution}` → 204 | setPreviewResolution |
| POST | `/api/v1/dashboards/:id/publish` | → 202 | publish |
| POST | `/api/v1/dashboards/:id/assist` | `{note?}` → 202 | callAssist |
| POST | `/api/v1/dashboards/:id/assist/end` | → 202 | endAssist |
| GET | `/api/v1/settings` | → `ModelSettings` | getSettings |
| PUT | `/api/v1/settings` | `ModelSettings` → 204 | saveSettings |
| POST | `/api/v1/model-gateway/probe` | `{settings: ModelSettings}` → `ProbeResult`（真实探测，永远不抛错，错误体现在 ProbeResult.ok=false） | testConnection |

## SSE

`GET /api/v1/dashboards/:id/events`

- 帧格式：`id: <seq>` + `event: <type>` + `data: <json>`，`<type>` ∈ `ClientEventMap` 的 10 个键（message / messageUpdated / stage / issue / blocker / previewReady / versionAdded / runStatus / dashboardUpdated / assist），data 载荷与 `ClientEventMap[type]` 完全一致（含 dashboardId）。
- `seq` 单大屏内单调递增；事件同时落盘 `server/data/events/<dashboardId>.jsonl`（append-only）。
- 重连带 `Last-Event-ID: <seq>` 时先补发缺失事件再续流（EventSource 自动携带）。心跳：每 15s 一行 `: ping`。

## 静态预览

`/preview/<dashboardId>/<versionId>/index.html` —— 构建产物自包含 HTML（1920×1080，禁止外部资源引用）。
`previewReady` / 快照里的 `previewUrl` 是相对路径（`/preview/...`），客户端拼接 base URL。

## 行为语义（与 mock 剧本一致，但内容由真实大模型驱动）

- 新建：理解需求（LLM 分析需求+参考图）→ 如需澄清发澄清卡片（≤3 题、恰一个★推荐+理由）并 `awaiting_clarification` + blocker(clarification) → 回答后继续 → 查找组件 → 编写页面（LLM 生成完整 HTML）→ 视觉检查（确定性校验 + LLM 结构化布局审查，最多报 3 个问题）→ 修复问题（发现问题时：每个问题一张 Issue 卡、LLM 修复≤2 次，再失败→卡点卡片：★推荐按规则表；无问题则直接打勾）→ previewReady + versionAdded + 「你的大屏做好了」。
- 修改：精简 3 阶段（修改→构建→检查），LLM 基于当前 HTML + 指令改稿，产生新节点。
- 生成中 sendMessage = 排队，当前阶段完成后合并处理，消息带 `queued: true`。
- 发布：进入等待审批，5 秒后审批通过（一期自动），版本打 ★、大屏状态已发布。
- 回退：复制目标版本产物生成新节点，历史不删。
- 协助：callAssist → 1 秒后客服「小李」接入（assist 事件流：查看执行过程…/代办动作），endAssist 结束并发小结系统条。
