# 贡献指南

感谢你愿意为 AI 大屏工作台贡献代码！这份文档帮你快速上手。

## 开发环境

- Node.js ≥ 20
- 克隆后一键启动：`npm run setup && npm run dev`（等价于 `./scripts/dev.sh`）

```bash
npm run setup       # 安装 client/ 与 server/ 依赖
npm run dev         # 服务端(:8787) + Electron 客户端
npm run typecheck   # 两端类型检查
npm run smoke       # 端到端冒烟（stub LLM 全流程，无需真实 Key）
```

## 提交前检查（必过）

1. `npm run typecheck` —— 客户端 `vue-tsc` + 服务端 `tsc --noEmit`
2. `npm run smoke` —— 改动涉及服务端 / 契约时必跑

本仓库没有单元测试框架，以上两项就是全部质量门禁。

## 契约优先（最重要的规则）

- 业务类型唯一定义在 `client/src/types/index.ts`，事件载荷唯一定义在 `client/src/api/client.ts` 的 `ClientEventMap` / `WorkbenchSnapshot`。
- 服务端 `server/src/wire.ts` 用 `import type` **原样引用**这些类型，**禁止改名或另造类型**。
- 改契约 = 改 client 侧定义 + 同步更新 `API_CONTRACT_HTTP.md`，三者必须同进一个 PR。

## 客户端铁律（详见 client/CONTRACT.md）

1. 文案一律简体中文大白话，禁止技术术语；状态徽标只有四种：`生成中` / `已完成` / `已发布` / `需要处理`。
2. 颜色 / 圆角 / 阴影 / 字体只用设计令牌（`client/src/styles/tokens.css`），禁止写死色值。
3. 不随意添加依赖；卡片组件通过 props 接收数据 + emit 事件，不直接 import store。
4. UI 组件只读 store、只调 store action；store 内部调 api 并订阅 `api.on` 事件。

## 分支与提交

- 从 `main` 切功能分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat: ...` / `fix: ...` / `docs: ...` / `refactor: ...`。
- 一个 PR 只做一件事；涉及契约改动时在 PR 描述里显式标注。

## 报告问题

使用 Issue 模板提交 bug 或功能建议。报 bug 时请附上：

- 复现步骤与期望行为
- 运行模式（Mock / stub LLM / 真实模型）与操作系统
- 相关日志（服务端控制台或 `server/data/events/<id>.jsonl`）

## 安全

请不要在公开 Issue 中报告安全漏洞（如 Key 泄露风险），先通过 GitHub Security Advisory 私密联系维护者。
