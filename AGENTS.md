# AI Dashboard Agent 指南

## 项目定位

本仓库是 Loop Engineer 工作台，同时生成两类产物：

- `dashboard`：固定画布的数据大屏。
- `business-app`：基于 Vue 3 + Vite + IDux 的完整、多模块业务应用。

所有功能与产出物必须同时满足准确性、体验性和安全性，不能以其中一项换取另一项。

## 必须先读

分析、开发、重构、调试或评审本仓库时，先完整阅读 [`.codex/ai-dashboard-skill/SKILL.md`](.codex/ai-dashboard-skill/SKILL.md)，再按其中路由读取相关 references。该 skill 是当前项目工程实践入口。

事实源按以下顺序判断：当前代码与测试、共享 API/类型契约、当前架构文档、UX/可观测性文档、README 与历史计划。发现不一致时，在同一改动中修正文档。

关键设计事实源包括 `API_CONTRACT_HTTP.md`、`AI_DASHBOARD_CLIENT_UX.md`、`AI_DASHBOARD_OBSERVABILITY.md`、`docs/multi-artifact-architecture.md`、`docs/loop-engine-design.md` 和 `client/CONTRACT.md`；具体适用范围与历史内容辨别规则见 skill 的 architecture reference。

## 不可违背的边界

1. 不把普通表格或管理页面路由成大屏；项目创建后不得静默切换 `artifactKind`。
2. `business-app` 不限定云主机或固定列表结构，必须支持任意领域、多模块、视图、动作、工作流、权限和数据契约。
3. 业务应用需求存在阻塞歧义时每轮只问一个关键问题，契约达到 `ready` 后才能生成。
4. 参考图只提供呈现证据，文字需求和用户决策决定业务语义。
5. Loop 遇到失败要识别、修复、复检；自主策略未耗尽前不得把“重新生成/人工协助”作为默认出口。
6. 失败候选不得进入版本历史；提交、回退、发布必须基于明确且已验证的 Revision。
7. 客户端组件只通过 store 读写业务状态；服务端线协议类型从客户端共享契约原样引用。
8. 禁止提交密钥、令牌、私网地址、个人信息、`server/data/` 或其他运行时数据。
9. 新增文件、公共类型、核心方法和复杂状态/安全逻辑使用准确、简洁的标准中文注释。
10. 不使用硬编码领域、假交互、吞错、无限重试或表面样式补丁掩盖架构问题。

## 开发与 Git

- 开始前检查分支、远端和工作区，保留用户已有改动。
- 大型功能基于最新主线时，同时核对个人 `origin` 与上游 `jouryjc`；工作区不干净时不要擅自 merge/rebase。
- 使用 `rg` 搜索文件和符号，使用 `apply_patch` 编辑文本文件。
- 未经用户明确要求，不提交、推送、创建 PR、合并或重写历史。
- 用户指定个人 origin 或上游目标时严格区分，不向错误仓库合并。

## 最低验证矩阵

| 改动 | 必须验证 |
| --- | --- |
| 文档 | `git diff --check` |
| LoopEngine | `npm --prefix loop-engine test` |
| 客户端/共享契约 | `npm run typecheck`，打包相关再跑 `npm run build` |
| 服务端/Prompt/路由 | `npm run typecheck` + `npm run smoke` |
| business-app 生成与验收 | `npm --prefix server run smoke:business-app` |
| 跨包或发布链路 | `npm run build` + 相关 smoke |

交付时报告实际执行的验证、未执行项和当前 Git 状态。
