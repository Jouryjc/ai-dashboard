# AI 大屏工作台客户端 · 协作契约

> 本文件是 7 个并行 agent 的协作边界。**先读对应章节再动手。**
> 交互与文案基准：`/home/jouryjc/ai-dashboard/AI_DASHBOARD_CLIENT_UX.md`
> 视觉基准：`/home/jouryjc/ai-dashboard/stitch-reference/`（home-a/b/c.html、workbench.html + screenshots/）

## 1. 铁律

1. **文件所有权**：只能创建/修改分配给你的文件（见 §5 所有权表），其他文件一律只读。
2. **不许运行 `npm install` / 添加依赖**。缺依赖在返回结果里说明，由集成阶段统一处理。
3. **文案用简体中文大白话**，禁止技术术语。状态徽标只有四种：`生成中` / `已完成` / `已发布` / `需要处理`。
4. **类型与跨模块导入只走契约路径**：`src/types/index.ts`、`src/api/`、`src/stores/`。不要复制类型定义，不要绕过 store 直接调 api（stores 内部除外）。
5. **颜色/圆角/阴影/字体只用设计令牌**（`src/styles/tokens.css` 的 Tailwind 类），禁止写死色值。

## 2. 技术栈与运行

Electron + Vite + Vue 3（`<script setup>`）+ TypeScript + Pinia + Vue Router + Tailwind CSS v4。

```bash
npm run dev          # Vite 开发服务器（浏览器预览用）
npm run electron:dev # 起 Vite 并拉起 Electron 窗口
npm run typecheck    # vue-tsc 类型检查（提交前必过）
npm run build        # 渲染层 + Electron 主进程构建
```

路由（hash 模式）：`/` 首页、`/workbench/:id` 工作台、`/settings` 设置。

## 3. 目录结构

```
client/
├── electron/            # 主进程 + preload（脚手架所有，业务别动）
├── scripts/             # 本地开发脚本（脚手架所有）
├── public/
│   ├── covers/          # 大屏卡片封面（home agent）
│   └── preview/         # mock 预览产物 HTML（mock-engine agent）
└── src/
    ├── main.ts / App.vue / router.ts / env.d.ts   # 入口（脚手架所有）
    ├── styles/tokens.css          # 设计令牌（脚手架所有，缺令牌在返回结果里提）
    ├── types/index.ts             # 领域类型（脚手架所有，缺字段在返回结果里提）
    ├── api/
    │   ├── client.ts              # ClientApi 接口 + 事件表（脚手架所有）
    │   ├── index.ts               # 当前实现入口（指向 mock）
    │   └── mock/engine.ts         # mock 引擎（mock-engine agent）
    ├── stores/                    # 四个 Pinia store（脚手架所有，唯一数据源）
    ├── pages/                     # 三个页面（见所有权表）
    └── components/
        ├── home/  chat/  cards/  preview/  topbar/  execution/  settings/
```

## 4. 数据流（唯一姿势）

UI 组件 **只读 store、只调 store action**；store 内部调 `api` 并订阅事件。事件流：

```
mock 引擎 --(api.on 事件)--> stores --> 组件
组件 --(store action)--> api 方法 --> mock 引擎
```

### 4.1 首页：useDashboardsStore（src/stores/dashboards.ts）

```ts
const store = useDashboardsStore()
onMounted(() => store.fetchAll())
store.sorted                 // 按最近修改排序的卡片列表（渲染这个）
store.byId(id)               // 按 ID 查
await store.create('新大屏') // 返回 Dashboard，然后 router.push(`/workbench/${d.id}`)
await store.rename(id, name)
await store.remove(id)
// 徽标文案：DASHBOARD_STATUS_LABEL[d.status]（src/types）
// 徽标配色：bg-status-generating / bg-status-done / bg-status-published / bg-status-attention
```

### 4.2 工作台：useSessionStore + useChatStore

进入/离开（WorkbenchPage 负责，集成阶段写）：

```ts
const session = useSessionStore()
await session.open(id)   // 拉快照 + 订事件 + 自动联动 chat store
session.close()          // 返回首页前调
```

session（预览 + 执行面板 + 顶栏）：

```ts
session.runStatus / session.statusText   // 五态 + 大白话一句话
session.stages                           // 阶段时间线：state 为 'done'|'active'|'pending'（✓●○）
session.issues                           // Issue：title / attempt（第几次尝试）/ status / beforeShotUrl / afterShotUrl
session.blocker                          // 卡点行动区数据（null = 无卡点）；options 即行动按钮组
session.versions / session.versionLabel  // 版本抽屉 / 顶栏 "v3 · 已保存"
session.previewState / session.previewUrl // 'empty'|'building'|'ready' 三态
session.viewingVersionId                 // 非 null 时顶栏显示"正在查看历史版本"横幅
session.assistSession                    // 人工协助卡片（null = 无）
session.canPublish / session.canRollback // 按 UX §7.1 矩阵算好的开关
session.panelCollapsed / session.togglePanel()

await session.rollback(versionId)        // UI 先做二次确认再调
await session.previewVersion(versionId) / await session.backToCurrent()
await session.publish()                  // UI 先弹确认再调
await session.callAssist(note?) / await session.endAssist()
await session.setResolution('2560x1440')
```

chat（对话区）：

```ts
const chat = useChatStore()
chat.messages                // 五型消息联合，按 m.kind 渲染：user/agent/clarification/problem/system
chat.latestClarification     // 未答澄清卡片（卡点"去回答"滚动定位用）
chat.activeProblem           // 未决问题处理卡片
await chat.send(text, attachmentUrls?)     // 输入框永不锁定，生成中自动排队
await chat.answerClarification(messageId, [{ questionId, optionId, customText: '' }])
await chat.chooseOption(optionId)          // 问题卡片选项和右栏行动区按钮都调这一个（两处等效）
```

**关键联动**：问题处理卡片（chat.activeProblem.options）与右栏卡点行动区（session.blocker.options）渲染同一组 option id，点击都调 `chat.chooseOption(optionId)`，状态天然一致。

### 4.3 设置：useSettingsStore（src/stores/settings.ts）

```ts
const s = useSettingsStore()
onMounted(() => s.load())
// 表单直接 v-model s.settings.provider / apiBase / apiKey / model
await s.save()
await s.testConnection()
s.probe?.message             // 大白话结论直接展示（"连接成功，支持图片理解，所有功能可用"）
s.probe?.detail              // 错误细节收在「查看详情」
s.isMultimodal               // false 时附件按钮置灰 + hover 提示换模型
```

## 5. 文件所有权表

| Agent | 可创建/修改 | 只读（禁改） |
|---|---|---|
| home agent | `src/pages/HomePage.vue`、`src/components/home/**`、`public/covers/**`（可从 `stitch-reference/screenshots/dash-*.png` 拷贝封面） | 其他一切 |
| chat agent | `src/components/chat/**` | 其他一切 |
| cards agent | `src/components/cards/**`（澄清卡片、问题处理卡片等可复用卡片组件） | 其他一切 |
| preview agent | `src/components/preview/**`、`src/components/topbar/**` | 其他一切 |
| exec-panel agent | `src/components/execution/**`（阶段时间线、Issue 卡片、卡点行动区、协助卡片） | 其他一切 |
| settings agent | `src/pages/SettingsPage.vue`、`src/components/settings/**` | 其他一切 |
| mock-engine agent | `src/api/mock/**`（`client.ts` 接口除外）、`public/preview/**` | 其他一切 |
| 集成阶段 | `src/pages/WorkbenchPage.vue` 组装、依赖变更 | — |
| 脚手架（已完成） | `electron/`、`scripts/`、`src/main.ts`、`App.vue`、`router.ts`、`env.d.ts`、`styles/tokens.css`、`types/`、`api/client.ts`、`api/index.ts`、`stores/**`、根配置文件 | — |

**需要跨边界改动时**（加类型字段、加 store action、加设计令牌、加依赖）：不要自己改，写进返回结果，由集成阶段处理。

## 6. 组件间约定

- 卡片组件（cards agent）通过 **props 接收数据 + emit 事件**，不直接 import store；使用方（chat agent 的对话流、exec-panel agent 的行动区）负责接 store。这样同一张卡片能在两处复用。
- 预览区用 `<iframe>` 加载 `session.previewUrl`（指向 `public/preview/` 下的 mock 页面），按 1920×1080 逻辑分辨率等比缩放。
- 滚动容器统一细滚动条风格即可，不做自定义组件。
- 图标：暂用文字/emoji/简单 SVG，不引入图标库（缺依赖统一报集成阶段）。
