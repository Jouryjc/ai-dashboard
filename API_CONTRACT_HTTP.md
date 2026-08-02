# AI 大屏工作台 · HTTP API 契约（服务端 ⇄ 客户端）

> 唯一事实源。服务端（server/）与客户端 HTTP 适配层（client/src/api/http/）都以此为准。
> 业务类型（Dashboard / ChatMessage / Stage / Issue / Blocker / Version / AssistSession / RunStatus / ProbeResult / ModelSettings / McpAuthType / McpDataSource / DataSourceProbeResult / ClarificationAnswer / PreviewResolution）定义见 `client/src/types/index.ts`，事件载荷见 `client/src/api/client.ts` 的 `ClientEventMap` 与 `WorkbenchSnapshot`，**两边原样引用，不改字段名**。

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
| POST | `/api/v1/dashboards/:id/messages` | `{text, attachments?: string[]}` → 202。attachments 为 dataURL（客户端已把 blob: 转好）或 http(s) URL；新建需求带图片附件时进入复刻模式（见「行为语义」）。错误：400（消息为空/超过 4000 字；附件超过 3 张、单张超过 5MB、或格式不是 PNG/JPG/WebP 的 dataURL）；429（同一 IP 每分钟最多 20 条，超限回 `{error:'你说得太快啦，歇一秒再发'}`） | sendMessage |
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
| GET | `/api/v1/settings` | → `ModelSettings`（apiKey 脱敏返回：超过 8 位显示前 3 位 + `…` + 后 4 位，≤8 位全部打码；永远不明文返回） | getSettings |
| PUT | `/api/v1/settings` | `ModelSettings` → 204。apiKey 回传的是脱敏掩码值则保留原密钥不动；传空字符串清空密钥；传新明文则更新 | saveSettings |
| POST | `/api/v1/model-gateway/probe` | `{settings: ModelSettings}` → `ProbeResult`（真实探测，永远不抛错，错误体现在 ProbeResult.ok=false） | testConnection |
| GET | `/api/v1/data-sources` | → `McpDataSource[]` | getDataSources |
| PUT | `/api/v1/data-sources` | `McpDataSource[]` → 200 + `McpDataSource[]`（全量覆盖式保存，返回规整后的列表：自动补 id） | saveDataSources |
| POST | `/api/v1/data-sources/probe` | `{source: McpDataSource}` → `DataSourceProbeResult`（真实探测，永远不抛错，错误体现在 ok=false） | probeDataSource |

通用约定：
- 所有 `:id` / `:messageId` / `:optionId` / `:versionId` 路径参数只接受字母、数字和 `-` `_`（最长 64 位），不满足一律 400 `{error:'请求参数不对'}`（防目录遍历，这些 id 会拼进文件路径）。
- 大屏名称（POST /dashboards、rename）最长 50 字，超出 400。
- 错误统一为 `{error: 大白话提示}` JSON，客户端原样展示。

## SSE

`GET /api/v1/dashboards/:id/events`

- 帧格式：`id: <seq>` + `event: <type>` + `data: <json>`，`<type>` ∈ `ClientEventMap` 的 12 个键（message / messageUpdated / stage / step / issue / blocker / previewReady / previewBuilding / versionAdded / runStatus / dashboardUpdated / assist），data 载荷与 `ClientEventMap[type]` 完全一致（含 dashboardId）。
- `step`（执行轨迹）：阶段节点下的实时动作流——Agent 做的每件具体事（精读参考图/备料/比对模板/取数/编写/截图/对比检查/修复尝试），文案在服务端写入时固化成大白话。`reset=true` 表示新一轮开始，先清空此前全部动作记录再插入本条。快照 `WorkbenchSnapshot.steps` 带全量（时间升序）。
- `seq` 单大屏内单调递增；事件同时落盘 `server/data/events/<dashboardId>.jsonl`（append-only）。
- 重连带 `Last-Event-ID: <seq>` 时先补发缺失事件再续流（EventSource 自动携带）。心跳：每 15s 一行 `: ping`。

## 静态预览与截图

`/preview/<dashboardId>/<versionId>/index.html` —— 构建产物自包含 HTML（1920×1080，禁止外部资源引用）。
`previewReady` / 快照里的 `previewUrl` 是相对路径（`/preview/...`），客户端拼接 base URL。

`/shots/<dashboardId>/<file>.png` —— 视觉检查与修复循环留下的真截图（无头浏览器按 1920×1080 截取）。
Issue 的 `beforeShotUrl`（修复前）/ `afterShotUrl`（修复后）就是这里的相对路径（`/shots/...`），
与 `previewUrl` 同一规则：客户端拼接 base URL 后再展示；字段为 `null` 表示这次检查没留图（如环境缺浏览器降级为文本审查）。

## 行为语义（与 mock 剧本一致，但内容由真实大模型驱动）

- 新建（创建统一走 skill 流程，按有无参考图分流为复刻/创作两种模式，见下两条）：理解需求（LLM 分析需求，有参考图一起读）→ 如需澄清发澄清卡片（≤3 题、恰一个★推荐+理由）并 `awaiting_clarification` + blocker(clarification) → 回答后继续 → 按模式编写页面 → 视觉检查（确定性校验 + 无头浏览器截图 + vision 审查，最多报 3 个问题；环境缺浏览器或模型不支持看图时降级为纯文本审查）→ 修复问题（发现问题时：每个问题一张 Issue 卡、LLM 修复≤2 次，Issue 带修复前后真截图 `beforeShotUrl`/`afterShotUrl`；再失败→卡点卡片：★推荐按规则表；无问题则直接打勾）→ previewReady + versionAdded + 「你的大屏做好了」。
- 复刻模式（attachments 含图片且模型支持图片理解）：读图精读（全图 + 局部裁剪，LLM 把参考图拆成布局/面板/数值/配色清单，数值照抄原图）→ 备料（地图等素材提前确定）→ 编写页面（Coder 带参考图 + 清单生成，产物自包含）→ 截图对比审查（成品截图与参考图同视角比对还原度）。
- 创作模式（无参考图；或有图但模型看不懂图，按本模式走并用 agent 消息大白话说明"图没用上"）：按内置大屏设计规范生成（选骨架 → 列面板清单 → 算高度预算 → 组装）→ 截图检查表审查（查裁切/溢出/错位）。
- 修改：精简 3 阶段（修改→构建→检查），LLM 基于当前 HTML + 指令改稿，产生新节点。
- 生成中 sendMessage = 排队，当前阶段完成后合并处理，消息带 `queued: true`。
- 发布：进入等待审批，5 秒后审批通过（一期自动），版本打 ★、大屏状态已发布。
- 回退：复制目标版本产物生成新节点，历史不删。
- 协助：callAssist → 1 秒后客服「小李」接入（assist 事件流：查看执行过程…/代办动作），endAssist 结束并发小结系统条。

## 追加（封面自动更新 + 导出代码）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/dashboards/:id/cover` | 客户端上传大屏封面截图。body `{image: string}`（data:image/png;base64 dataURL，≤8MB）。服务端校验 PNG 魔数 → 存 `data/covers/<dashId>.png` → `dashboard.coverUrl = /covers/<dashId>.png?t=<时间戳>` → 发 `dashboardUpdated` → 204 |
| GET | `/api/v1/dashboards/:id/versions/:versionId/export` | 导出该版本完整 HTML：`200 text/html` + `Content-Disposition: attachment; filename*=UTF-8''<大屏名>-<版本标签>.html`（RFC 5987 编码）。版本不存在 → 404 |

ClientApi 新增方法（mock 也要实现）：
- `uploadCover(dashboardId: string, imageDataUrl: string): Promise<void>` —— mock：空操作（mock 模式封面仍用关键字示例图）
- `exportVersionUrl(dashboardId: string, versionId: string): string` —— http：返回 export 端点绝对地址；mock：返回该版本的 /preview 相对地址

封面上传时序（客户端行为，非服务端职责）：previewReady 事件后（http 模式且 Electron 环境有 captureUrl 能力时）离屏截取预览 1920×1080 → uploadCover，fire-and-forget，失败静默。每个版本最多上传一次。
