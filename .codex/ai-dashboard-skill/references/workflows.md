# 开发与诊断工作流

## 常用命令

从仓库根目录运行：

```bash
npm run setup                         # 安装 client 与 server 依赖
npm run dev                           # scripts/dev.sh：服务端 + Electron
npm run typecheck                     # 服务端 tsc + 客户端 vue-tsc
npm run smoke                         # 完整服务端端到端冒烟
npm run build                         # 服务端、Web 渲染层与 Electron 构建
npm --prefix loop-engine test         # LoopEngine 单元测试
npm --prefix server run smoke:business-app
```

分包调试：

```bash
npm --prefix server run dev
npm --prefix client run dev
npm --prefix client run electron:dev
node server/scripts/stub-llm.mjs 9100
node server/scripts/stub-llm.mjs 9100 --no-vision
```

Windows 未配置 Bash 时，分别启动 server 和 client，不要因为根 `npm run dev` 调用 `scripts/dev.sh` 失败就修改产品代码。

## 常用环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `VITE_API_BASE` | 空 | 空时客户端走 Mock；设置后走 HTTP/SSE 服务端 |
| `PORT` | `8787` | API 服务端口 |
| `PREVIEW_PORT` | `8788` | 隔离预览服务端口 |
| `PREVIEW_ORIGIN` | 本地预览地址 | 对外公布的预览 origin |
| `DATA_DIR` | `server/data/` | 本地 JSON/JSONL、工作区和预览数据根目录 |
| `AGENT_STEP_MAX_MS` | 20 分钟 | Agent 单步骤看门狗 |
| `IDUX_BUILD_TIMEOUT_MS` | 60 秒 | business-app Vite 构建超时 |
| `IDUX_BUILD_MAX_OUTPUT_BYTES` | 2 MB | business-app 构建日志上限 |
| `SMOKE_PORT`、`STUB_PORT`、`VERBOSE` | 自动 | 冒烟与 stub 调试 |

模型地址、Key 和模型名优先通过客户端设置页或被忽略的本地环境配置维护；不要写入源码或示例文档。

## 开始大型改动

1. 检查 `git status -sb`、当前分支和 `git remote -v`。
2. 确认 `origin` 与 `jouryjc` 的角色。需要基于最新主线开发时先 fetch 两个远端，比较 `origin/main`、`jouryjc/main` 与当前分支；工作区不干净时不要直接合并或变基。
3. 用 `rg` 定位入口、类型、测试和旧名称，不只看单个生成器。
4. 写出期望行为、实际行为、复现条件和验收门禁。
5. 若根因跨层，按领域契约、编排、生成、验证、UI 的顺序处理，不在最末端打补丁。

## 修改 business-app

按以下依赖方向推进：

1. `domain/model.ts`：先修改可序列化契约。
2. `domain/validation.ts`：补充跨引用、不变量和安全断言。
3. `requirements/analyzer.ts`：识别阻塞未知项；保持一轮一个问题。
4. `planning/planner.ts`：生成完整蓝图和增量计划；保护非目标模块。
5. `generation/renderer.ts`：只解释蓝图，不重新推断业务。
6. `generator.ts`：编排证据与文件，不塞领域页面特例。
7. `adapter.ts`、`builder.ts`：增加静态完整性和安全门禁。
8. `validator.ts`：把新能力变成可执行场景，而不是元素存在检查。
9. `orchestrator.ts`：持久化新状态、候选与检查点，并接入修复循环。
10. 同步 stub、smoke、Prompt 文档、架构文档和中文注释。

避免以下回归：

- 用云主机、配额或用户管理预设限制任意领域能力。
- 只生成列表和 Toast，把按钮存在误认为任务闭环。
- 新增模块时拼接历史自然语言，导致需求串味。
- 新请求沿用上一轮澄清答案。
- 失败候选覆盖已提交蓝图。
- 模型修改契约、蓝图、证据或无关模块。

## 修改 dashboard

- 保持固定画布、自包含 HTML、模板/数据源/视觉审查边界。
- 区分参考图复刻和纯文本创作；无视觉能力时不要静默忽略图片。
- 真实数据与生成 HTML 分离落盘，预览阶段再安全内联。
- 保留生成中预览、超时拆分、断源卡片、Issue 修复前后状态和版本回退行为。
- 修改旧 orchestrator 路径时运行完整 `npm run smoke`，防止 business-app 改动破坏 dashboard 回归。

## 修改共享契约或客户端

1. 从 `client/src/types/index.ts` 和 `client/src/api/client.ts` 修改源类型。
2. 让 `server/src/wire.ts` 继续使用 `import type` 原样引用。
3. 同步 HTTP/Mock 两种 ClientApi 实现、Pinia store 和 SSE 事件。
4. 更新 `API_CONTRACT_HTTP.md`。
5. UI 使用简体中文大白话和 `client/src/styles/tokens.css` 设计令牌。
6. 卡片通过 props/emit 复用，不直接依赖 store；页面负责接线。
7. 至少运行根目录 `npm run typecheck`；涉及 Electron 或打包时运行 `npm run build`。

## 修改 Prompt 或运行时 skill

- Prompt 放在 `server/prompts/*.md`，代码只传结构化变量。
- 修改占位符时同步 `server/prompts/README.md` 和调用点。
- stub 依赖角色文本识别请求类型，新增/更名角色时同步 `server/scripts/stub-llm.mjs`。
- `server/skills/<id>` 必须同时提供合法 `SKILL.md` 与 `skill.config.json`，目录名、frontmatter name、config id 一致。
- `idux-cli` 只提供目标版本 API/demo 证据；`idux-enterprise-design` 负责通用 B 端信息架构、页面模式、操作/状态与 Loop 门禁；`idux-style` 只负责视觉基线、主题和壳层样式资产，三者不混合职责。
- 运行命令采用白名单、无 shell、受限 cwd/env/超时/输出；不要把自然语言拼进命令。

## 新增产物类型

1. 扩展共享 `ArtifactKind` 和创建契约。
2. 实现 `ArtifactAdapter`：TargetProfile、Manifest、静态校验、导出命名。
3. 在 Artifact Registry 注册。
4. 为生成、构建、验证、预览、导出、回退和发布提供完整实现。
5. 首页显式展示类型，工作台持续显示类型，创建后锁定。
6. 为意图路由增加正例、反例和模糊澄清测试。
7. 增加跨产物回归，确认没有静默走 dashboard 默认路径。

## 排查“卡很久”或失败流程

按证据顺序检查：

1. 工作台 `runStatus`、active stage、AgentStep 和 blocker 是否一致。
2. SSE 是否持续输出，是否存在 active step 永不结束。
3. `server/data/events/<id>.jsonl` 与 session 快照是否有最后进展。
4. 模型 probe、超时、AbortSignal 和 provider 错误是否正确映射。
5. Loop 图的 current、awaiting、节点状态和 checkpoint 是否一致。
6. 构建日志、ValidationReport、失败 gate 和场景截图是否能复现。
7. 修复策略是否被错误重置或重复尝试。
8. 只有确认外部授权/环境缺失或策略耗尽后才阻断用户。

修复后重跑原始用户场景，不以“请求成功”“页面能打开”替代需求验收。

## Git 与交付

- 保留用户改动，避免 `git reset --hard`、强推和未经许可的变基。
- 提交前检查 diff 范围、敏感信息、删除文件和生成数据。
- 用户说“提交上库”时提交并推送当前工作分支；除非同时要求，不创建或合并 PR。
- 用户指定 PR 目标时，以该目标为准，尤其区分个人 `origin/main` 与 `Jouryjc/ai-dashboard` 上游。
- 交付说明包含分支、commit、远端、验证结果和未执行项。
