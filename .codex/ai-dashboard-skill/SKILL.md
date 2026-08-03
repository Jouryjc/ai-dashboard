---
name: ai-dashboard-skill
description: 维护和演进 ai-dashboard 仓库的项目级工程指南。用于分析、开发、重构、调试或评审 dashboard、business-app、LoopEngine、Vue/Electron 客户端、Express/SSE 服务端、生成 Prompt、项目 skills、IDux 生成链路、质量门禁、版本持久化与发布相关任务。
---

# AI Dashboard 工程指南

把本项目视为“可恢复的 AI 产物工程工作台”，而不是单页生成器。始终围绕准确性、体验性、安全性完成端到端闭环。

## 开始任务

1. 读取根目录 `AGENTS.md`。
2. 运行 `git status -sb`、`git remote -v`，确认分支、远端和用户已有改动；禁止覆盖不属于本任务的工作区内容。
3. 按任务读取参考资料：
   - 涉及产物路由、Loop、状态、持久化或模块边界时，读取 [references/architecture.md](references/architecture.md)。
   - 涉及实现、调试、Prompt、客户端或新增产物时，读取 [references/workflows.md](references/workflows.md)。
   - 涉及验收、交互、安全、修复或代码评审时，读取 [references/quality-security.md](references/quality-security.md)。
4. 读取任务直接关联的事实源和代码，不用旧文档猜测当前实现。

## 判断产物边界

- 将固定画布、指标监控、态势展示、数据可视化中心路由为 `dashboard`。
- 将管理表格、表单、详情、审批、用户/配额/订单等持续演进的软件路由为 `business-app`。
- 不从“包含表格”推断大屏。普通业务表格默认属于业务应用语境。
- 项目创建后锁定 `artifactKind`；后续生成、修改、回退、导出和发布不得静默换类型。
- 新产物类型必须通过 Artifact Adapter 接入，禁止在路由和 UI 中散落特例。

## 处理业务应用

1. 先形成 `RequirementContract`，再规划 `ApplicationBlueprint` 与增量 `ChangePlan`。
2. 把业务应用建模为任意领域的多模块、多视图、实体、动作、工作流、数据契约、权限和验收场景，不固化云主机或列表页结构。
3. 只有影响范围、核心流程、数据、权限或安全结果的未知项才阻塞生成；每轮只询问一个关键问题。
4. 将回答保存为结构化决策，恢复检查点后重新分析；契约达到 `ready` 前禁止进入规划。
5. 增量修改只替换目标模块，保留无关模块、历史需求覆盖和回归场景。
6. 参考图只控制应用壳、导航、视图类型、层级、密度和组件角色；文字需求与澄清决策始终是业务语义事实源。
7. 使用 Schema 驱动 IDux 运行时；不要重新引入固定列表模板或让模型任意改写契约、蓝图与证据。

## 处理 Loop 与失败

- 将调度、边、guard、挂起恢复和提交时机留在 LoopEngine；将节点业务、产物存储和选项语义留在业务层。
- 持久化检查点只保存 JSON-safe 状态；用 `flowId + flowVersion` 重新绑定可信流程定义并校验拓扑。
- 区分已提交蓝图和失败候选。未通过全部门禁的候选不得进入版本历史。
- 先识别失败门禁和根因，再按确定性修复、受约束模型修复、定向重规划、扩展证据重规划推进；每轮必须复检。
- 只有自主策略确实耗尽或缺少外部授权时，才提供调整需求或人工协助。不要把“重试”当作默认修复机制。
- 对架构性问题修复正确层级，不用硬编码领域、假反馈、吞错或表面 CSS 补丁掩盖根因。

## 实施规则

- 先建立可验证的需求与失败合同，再改代码。
- 保持契约单向：客户端共享类型是 HTTP/SSE 线协议源头，服务端 `wire.ts` 只引用，不另造同义类型。
- UI 组件只读 store、只调用 store action；store 调 API 并消费事件。
- 新增文件、公共类型、核心方法和复杂安全/状态逻辑使用标准中文注释，说明职责和边界，不逐行解释显然代码。
- Prompt 只放在 `server/prompts/`，更新占位符时同步 `server/prompts/README.md` 与 stub 分支。
- 运行时 skill 位于 `server/skills/`；项目工程 skill 位于 `.codex/`，不要混淆两者。
- 精确锁定生成运行时依赖和 IDux 证据版本；禁止模型引入任意依赖、脚本或网络请求。
- 不提交密钥、令牌、私网地址、真实个人信息或 `server/data/` 运行数据。
- 未经用户要求不要提交、推送、创建 PR、合并或重写历史。

## 验证并交付

按风险选择测试，不以类型检查替代行为验收：

```text
纯文档                       git diff --check
LoopEngine                   npm --prefix loop-engine test
客户端或共享契约             npm run typecheck；必要时 npm run build
服务端、Prompt、路由         npm run typecheck + npm run smoke
business-app 生成/验收       npm --prefix server run smoke:business-app
跨包、构建或发布链路         npm run build + 相关 smoke
```

报告实际执行的命令与结果；未执行的高价值验证要明确说明。交付前再次检查 `git diff --check`、`git status -sb` 和敏感信息。
