# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

AI 大屏工作台：用户在对话区用自然语言描述需求，Agent（Planner/Coder 走真实大模型）生成 1920×1080 自包含 HTML 大屏并实时预览。两个包：

- `client/` — Electron + Vue 3（`<script setup>`）+ TS + Pinia + Vue Router（hash 模式）+ Tailwind CSS v4 + Vite
- `server/` — Node + Express + TS，HTTP + SSE，JSON 文件持久化（无数据库），端口 8787

根目录文档是设计事实源：`AI_DASHBOARD_CLIENT_UX.md`（交互与文案基准）、`API_CONTRACT_HTTP.md`（两端 API 唯一事实源）、`client/CONTRACT.md`（客户端协作铁律）、`stitch-reference/`（视觉基准 HTML+截图）。

## 常用命令

```bash
./scripts/dev.sh            # 一键起服务端(:8787) + Electron 客户端

# client/
npm run dev                 # Vite 开发服务器（浏览器预览）
npm run electron:dev        # Vite + Electron 窗口
npm run typecheck           # vue-tsc，提交前必过
npm run build               # 渲染层 + Electron 主进程

# server/
npm run dev                 # tsx watch
npm run typecheck           # tsc --noEmit
npm run smoke               # 端到端冒烟（stub LLM 全流程，无需真实 Key）——本仓库唯一的"测试"
node scripts/stub-llm.mjs 9100   # OpenAI 兼容假模型，无 Key 联调用（--no-vision 模拟不支持看图）
```

没有单元测试框架；服务端的验证手段是 `npm run smoke`（断言式冒烟脚本），客户端是 `vue-tsc` 类型检查。

## 核心架构

### 契约优先，类型单向流动

业务类型唯一定义在 `client/src/types/index.ts`，事件载荷唯一定义在 `client/src/api/client.ts` 的 `ClientEventMap` / `WorkbenchSnapshot`。服务端 `server/src/wire.ts` 用 `import type` **原样引用**这些类型——字段名两端逐字段一致，**禁止在 wire.ts 改名或另造类型**。改契约 = 改 client 侧定义 + 同步 `API_CONTRACT_HTTP.md`。

### 客户端数据流（唯一姿势）

```
UI 组件只读 store、只调 store action
store 内部调 api（src/api/index.ts 导出的 ClientApi）并订阅 api.on 事件
```

`src/api/index.ts` 按 `VITE_API_BASE` 环境变量切换实现：存在 → `api/http/`（HTTP+SSE 适配层），否则 → `api/mock/`（剧本驱动 Mock 引擎）。stores 与 UI 对两种实现零改动。所有 api 方法是"发指令"立即返回，结果通过事件推回（SSE，支持 `Last-Event-ID` 补发）。

四个 store：`dashboards`（首页列表）、`session`（工作台预览/执行面板/顶栏）、`chat`（对话区）、`settings`。关键联动：问题处理卡片（chat.activeProblem.options）与右栏卡点行动区（session.blocker.options）渲染同一组 option id，都调 `chat.chooseOption()`。

### 服务端结构

- `src/gateway.ts` — 模型网关：OpenAI 兼容 chat/completions、超时/重试、probe 真实探测（chat + 1px vision 探针）、JSON/HTML 容错提取、provider 错误码大白话映射
- `src/orchestrator.ts` — Run 五态状态机（idle/generating/awaiting_clarification/blocked/assisting）、Planner/Coder 流程、创建统一走 skill 双模式（有图=复刻：读图精读→备料→带图生成；无图=创作：按内置设计规范生成）、确定性校验 + 截图校验闭环（无头浏览器截图 + vision 对比审查，环境缺失降级文本审查）+ 修复循环（≤2 次）、排队合并、发布/回退/人工协助、20 分钟单步看门狗（`AGENT_STEP_MAX_MS` 可调，编码超时自动拆分骨架+逐面板生成）
- `src/routes.ts` + `src/index.ts` — REST + SSE（15s 心跳）、CORS、静态托管预览产物
- `src/store.ts` — JSON 持久化 + 事件 jsonl（append-only，seq 单大屏递增，重启恢复）+ SSE 广播

持久化全在 `server/data/`（`DATA_DIR` 可覆盖）：`dashboards.json`、`settings.json`、`sessions/<id>.json`、`events/<id>.jsonl`、`previews/<dashId>/<versionId>/index.html`。预览产物必须自包含（禁止外部资源引用）。

### 客户端铁律（来自 client/CONTRACT.md）

1. 文案一律简体中文大白话，禁止技术术语；状态徽标只有四种：`生成中`/`已完成`/`已发布`/`需要处理`（`DASHBOARD_STATUS_LABEL`）
2. 颜色/圆角/阴影/字体只用设计令牌（`src/styles/tokens.css`），禁止写死色值
3. 不随意添加依赖；卡片组件通过 props 接收数据 + emit 事件，不直接 import store
4. 预览区用 `<iframe>` 加载 `session.previewUrl`，按 1920×1080 等比缩放

## 已知缺口（一期遗留）

- 重启后 generating/assisting 落回 idle（blocked/awaiting 靠 pendingRun 最大努力续跑）
- API Key 明文落 `server/data/settings.json`（单用户演示形态，勿用于生产）
- 协助修复为确定性清洗兜底；stall 卡点未实现
- 截图校验闭环已落地：无头浏览器截图 + vision 对比审查（缺浏览器或模型不支持看图时降级为纯文本审查），Issue 修复前后截图为真图（静态路径 `/shots/...`）
- 二期待定决策：C5 指哪改哪、C7 语音输入
