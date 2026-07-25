# AI 大屏工作台 · 服务端

把客户端从本地 Mock 切换到真实大模型的服务端：HTTP + SSE 契约（`../API_CONTRACT_HTTP.md`）+ 模型网关 + Orchestrator。

## 快速开始

```bash
npm install
npm run dev        # tsx watch，端口 8787
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm start          # node dist/server/src/index.js
npm run smoke      # 端到端冒烟（stub LLM + 全流程，无需真实 Key）
```

## 无 Key 联调

```bash
node scripts/stub-llm.mjs 9100          # 启动 OpenAI 兼容假模型
# 客户端设置里填：地址 http://127.0.0.1:9100/v1，Key 任意，模型 stub-1
# --no-vision 可模拟不支持看图的模型（probe 返回 supportsVision=false）
```

## 数据与持久化

全部 JSON 文件，无数据库（`server/data/`，可用 `DATA_DIR` 覆盖）：

- `dashboards.json` / `settings.json` / `sessions/<id>.json`
- `events/<id>.jsonl`：事件溯源 append-only，seq 单大屏递增，重启恢复，SSE 支持 `Last-Event-ID` 补发
- `previews/<dashId>/<versionId>/index.html`：自包含构建产物（禁止外部资源引用）
- `covers/`：启动时从 `client/public/covers` 拷贝的示例封面

## 安全提示

单用户演示形态：API Key **明文落本地文件** `data/settings.json`。请勿提交到仓库、勿用于生产；生产应换密钥引用（vault）或加密存储。

## 结构

- `src/gateway.ts`：模型网关（OpenAI 兼容 chat/completions、超时/重试、probe 真实探测、JSON/HTML 容错提取）
- `src/orchestrator.ts`：Run 状态机（idle/generating/awaiting_clarification/blocked/assisting）、Planner/Coder 流程、确定性校验 + 修复循环、问题处理卡片（推荐规则表）、倒计时自动执行、排队合并、发布/回退/人工协助
- `src/routes.ts` + `src/index.ts`：契约全部 REST + SSE（15s 心跳）、CORS、静态托管
- `src/store.ts`：JSON 持久化 + 事件 jsonl + SSE 订阅广播
- `src/wire.ts`：线协议类型，原样 `import type` 自 `client/src/types` 与 `client/src/api/client.ts`（字段名逐字段一致，只读 client，不改动）
