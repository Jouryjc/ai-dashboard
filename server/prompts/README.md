# Prompt 库

系统所有 LLM prompt 都集中在这里，**脱离代码独立维护**：直接编辑 .md 文件即生效（每次调用现读，改完不用重启服务）。

## 文件清单

| 文件 | 用途 | 占位变量 |
|---|---|---|
| `planner.system.md` | 规划师：理解需求、决定要不要澄清（输出分析结论 + 澄清问题 JSON） | — |
| `planner.user.md` | 规划师用户消息 | `{{text}}` `{{noVisionNote}}` |
| `planner.user.no-vision-note.md` | 模型看不了图时的附加说明 | — |
| `match.system.md` | 模板匹配师：需求/参考图 ↔ 模板库比对 | — |
| `match.user.md` | 匹配师用户消息 | `{{text}}` `{{catalog}}` `{{keywordHint}}` `{{modeNote}}` |
| `match.note-vision.md` / `match.note-text.md` | vision / 纯文本两种模式的附加说明 | — |
| `coder.system.md` | 大屏开发：自包含 HTML 的硬约束 | — |
| `coder.create.user.md` | 首次生成大屏 | `{{text}}` `{{answersBlock}}` `{{templateContext}}` `{{imageNote}}` |
| `coder.create.answers-block.md` | 用户已确认的澄清偏好 | `{{answersSummary}}` |
| `coder.create.image-note.md` | 附模板参考图时的说明 | — |
| `coder.edit.user.md` | 基于现有版本修改 | `{{currentHtml}}` `{{instruction}}` |
| `coder.repair.user.md` | 检查未通过后的修复 | `{{problems}}` `{{html}}` |
| `coder.template-context.md` | 模板命中结果注入块 | `{{layoutBlock}}` `{{componentsBlock}}` |
| `coder.template-context.layout-block.md` | 布局约束行 | `{{layoutName}}` `{{layoutStructure}}` |
| `coder.template-context.components-block.md` | 组件样式约束块 | `{{componentLines}}` |
| `review.system.md` | 布局检查员：结构化视觉审查 | — |
| `review.user.md` | 审查用户消息 | `{{requirement}}` `{{html}}` |
| `business-app-reference.system.md` | 业务应用参考图分析：图片转受控应用蓝图 | — |
| `business-app-reference.user.md` | 业务应用参考图分析用户消息 | `{{request}}` |
| `business-app-requirements.system.md` | 业务应用需求分析：识别缺失的阻塞决策，每次最多提出一个问题 | — |
| `business-app-requirements.user.md` | 业务应用需求分析用户消息 | `{{request}}` `{{decisions}}` `{{currentBlueprint}}` |
| `business-app-blueprint.system.md` | 业务应用蓝图规划：任意领域、多模块、视图、动作与工作流 | — |
| `business-app-blueprint.user.md` | 业务应用蓝图规划用户消息 | `{{contract}}` `{{currentBlueprint}}` `{{presentationEvidence}}` `{{fallbackShape}}` |
| `business-app-review.system.md` | 业务应用参考图与双视口视觉复核 | — |
| `business-app-review.user.md` | 业务应用视觉复核用户消息 | `{{request}}` `{{referenceNote}}` |
| `business-app-repair.system.md` | 业务应用有界源码修复与 B 端模式责任层约束 | `{{repairGuidance}}` |
| `business-app-repair.user.md` | 业务应用失败门禁与可编辑源码 | `{{requirement}}` `{{failedGates}}` `{{editableFiles}}` |
| `split.skeleton.user.md` | 超时拆分第 1 步：页面骨架（PANEL 占位） | `{{requirement}}` |
| `split.panel.user.md` | 超时拆分第 2..N 步：单个面板 | `{{requirement}}` `{{panelName}}` |

## 规则

1. **`{{变量名}}` 是占位符**，代码侧替换；改名/新增变量需要同步改 `server/src/orchestrator.ts` 的调用点。
2. **角色名不能改**：`你是「大屏规划师」/「模板匹配师」/「大屏开发」/「布局检查员」`——联调桩（`scripts/stub-llm.mjs`）靠角色名识别请求类型，改了 stub 会失效。
3. 输出格式约束（JSON 结构、`<!--PANEL:...-->` 占位约定、自包含/禁外部引用）与代码里的解析器一一对应，改之前先看 orchestrator 的 `normalizePlan` / `extractJson` / `extractHtml` / 拆分拼装逻辑。
4. 目录位置可用环境变量 `PROMPTS_DIR` 覆盖（默认 `server/prompts`）。
5. 改完建议跑 `npm run smoke` 确认没有破坏流程。
