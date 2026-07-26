// 产品化复刻/创作流程重构(方式3 修订版):skill 流程统一为有图无图的唯一生成路径。
//   有图 → 复刻模式:精读(裁剪+vision)→ 备料(GeoJSON→SVG)→ Coder 带图生成 → 截图校验闭环(对比原图)
//   无图 → 创作模式:Planner(可选声明地图 adcode)→ 备料 → Coder 按 design-language 设计规范生成 → 截图校验闭环(无原图,按检查表)
// 跨 server/client/契约文档的大改,按文件归属切片,
// A(基础设施)→ B(服务端集成)串行,C(客户端与契约)并行,D(验证修复)收尾,E(铁律审查)。
//
// 已确认的决策:图像处理用 Node 原生依赖(sharp + playwright,GeoJSON→SVG 纯 TS 移植);
// 有图无图都走 skill 流程(design-language.md 是用户刚定稿的设计规范,创作模式的审美权威);
// 所有新能力必须可降级(playwright/vision 缺 → 现有文本审查兜底),降级路径不报错不阻塞。

export const meta = {
  name: 'productize-replica',
  description: '把 big-screen-replica skill 流程产品化为唯一生成路径:复刻(有图)+创作(无图)+截图校验闭环',
  whenToUse: '方式3 大改:skill 复刻/创作双模式全流程集成到 AI 大屏工作台产品',
  phases: [
    { title: '基础设施', detail: 'replica.ts(sharp/playwright/GeoJSON)+ prompt 体系重构' },
    { title: '服务端集成', detail: 'orchestrator 双模式统一流程 + 截图审查闭环 + gateway/routes/store' },
    { title: '客户端与契约', detail: '契约文档、Issue 真实截图展示、CLAUDE.md 缺口更新' },
    { title: '验证修复', detail: 'npm install + 双端 typecheck + smoke,修到全绿' },
    { title: '铁律审查', detail: '契约一致/大白话文案/降级完备性 只读审查' },
  ],
}

const REPO = '/home/jouryjc/ai-dashboard'

const COMMON = `
仓库:${REPO}(Electron+Vue3 客户端 + Express 服务端,契约优先,类型单向流动)。

必须遵守的仓库铁律:
1. 业务类型唯一定义在 client/src/types/index.ts;server/src/wire.ts 只 import type 原样引用,禁止改名另造。
2. 界面文案与 agent 消息一律简体中文大白话,禁止技术术语(不说"DOM/渲染/HTTP",说"页面/生成/连接")。
3. prompt 一律放 server/prompts/*.md,用 prompt(name, vars) 加载,{{变量}} 占位;禁止在 TS 里写大段 prompt 字符串。
4. 所有 LLM 调用必须布防:try/catch + 看门狗(armAgentWatchdog)+ 失败不阻塞(沿用 orchestrator 现有容错风格)。
5. 预览产物必须自包含(禁止外部资源引用),这一约束要进 Coder prompt。
6. 工作树有大量未提交改动(数据源/MCP 功能),那是用户的在途工作:不许回退、不许格式化重排无关代码,只做自己的增量修改。
7. 直接改当前工作树的文件,不要新建 git 分支/worktree,不要 git commit。

设计规范的权威来源(写 prompt 前必须通读):
- server/skills/big-screen-replica/references/design-language.md(用户刚定稿的大屏设计系统:骨架 A/B/C、色彩令牌、字体阶梯、面板镀铬、组件选型、地图、密度节奏、动效、无图创作流程)
- server/skills/big-screen-replica/references/big-screen-patterns.md(组件级 CSS 片段库)
- server/skills/big-screen-replica/SKILL.md(双模式总流程)`

const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'filesChanged', 'apiSurface'],
  properties: {
    summary: { type: 'string', description: '做了什么,3-5 句' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    apiSurface: { type: 'string', description: '导出的函数签名/接口/新增或改动的 prompt 文件名与变量清单,逐条列出' },
    deviations: { type: 'string', description: '与任务书的偏差及原因;无偏差写"无"' },
  },
}

// ── A:基础设施(先行,B 依赖它的真实产物)─────────────────────
phase('基础设施')
log('A:replica.ts 基础设施 + prompt 体系(复刻/创作双模式)')
const sliceA = await agent(
  `你是服务端工程师,为"skill 流程统一生成路径"建基础设施。${COMMON}

你的文件领地(只许动这些):
- 新建 server/src/replica.ts
- server/prompts/ 目录(新建与修改下列文件,其他不动)
- 修改 server/package.json(加依赖)

== server/src/replica.ts 必须精确导出这套接口(签名逐字遵守,下游切片按此编程):==
\`\`\`ts
export interface ReplicaEnv { ok: boolean; sharpOk: boolean; browserOk: boolean; detail: string }
/** 探测 sharp 与 playwright chromium 是否可用;进程内缓存结果,失败给大白话 detail */
export function probeReplicaEnv(): Promise<ReplicaEnv>
export interface Region { left: number; top: number; width: number; height: number }
/** 把 data URL 图片按区域裁剪,返回 PNG data URL 数组(与 regions 等长) */
export function cropImageDataUrl(dataUrl: string, regions: Region[]): Promise<string[]>
/** 读 data URL 图片的像素尺寸 */
export function imageSize(dataUrl: string): Promise<{ width: number; height: number }>
/** 用 playwright 无头 chromium 把 HTML 渲染成 width×height 截图,返回 PNG data URL;浏览器不可用要抛错(调用方兜底) */
export function renderShotDataUrl(html: string, width: number, height: number): Promise<string>
export interface MapPaths { [name: string]: { d: string; cx: number; cy: number } }
/** GeoJSON → SVG 路径(参照 server/skills/big-screen-replica/scripts/geojson_to_svg.py 移植,等距圆柱投影+decimate 抽稀即可) */
export function geojsonToSvgPaths(geojson: unknown, width: number, height: number, decimate?: number): MapPaths
/** 下载 DataV GeoJSON(https://geo.datav.aliyun.com/areas_v3/bound/<adcode>_full.json),30s 超时,失败抛错 */
export function fetchGeoJson(adcode: string): Promise<unknown>
\`\`\`
实现要点:
- sharp 静态 import;playwright 用动态 import('playwright'),launch 失败/包缺失都在 probeReplicaEnv 里捕获 → browserOk=false。
- renderShotDataUrl:setContent(html) + viewport {width,height} + page.screenshot,每次用完关 browser context;加 120s 总超时。
- geojsonToSvgPaths 读那个 python 脚本逐行移植语义(含 Polygon/MultiPolygon、cx/cy 中心点),不许发明新算法。
- 文件顶部加中文注释块说明用途,风格对齐 server/src 现有文件。

== prompt 体系(server/prompts/,全部简体中文大白话,JSON 输出格式在 system 里写死):==

1. **重写 coder.system.md**(现有内容先读,保留 4 条硬约束)。新版 = 所有创建的统一系统 prompt:
   - 原有硬约束(完整自包含 HTML、1920×1080、图表内联手写、禁外部资源、只输出 HTML)逐条保留。
   - 注入 skill 方法论:固定设计稿舞台(1920×1080 写死 .stage)+ transform scale 等比缩放(ResizeObserver,外层容器高=设计高×s);高度预算(header+指标条+主区≤1080,动笔前先算)。
   - 注入 design-language.md 精要(浓缩,别整篇抄):三种骨架 A/B/C 的选型规则、色彩令牌表(深底/主青/主蓝/三级文字/语义色/无数据色)、字体与字号阶梯、面板三件套(半透明深蓝底+1px 蓝边+四角括号)、组件选型表(大数字→统计卡、占比→环形仪表、构成→堆叠条/环形、排名→徽章虚线条、明细→斑马纹表格、趋势→折线)、密度节奏(一屏 6-9 面板、每面板 1 件事、视觉重心唯一、三级数字对比)、动效只用三类(时钟/呼吸/飞线)+ prefers-reduced-motion 降级。
   - 无数据时用示例数据并标注,不编造看似真实的业务指标名。

2. **新建 coder.replica.system.md**(复刻增量,与 coder.system 串联使用,不重复其内容):提供了参考图与内容清单时,参考图优先、设计语言只补缺口;清单数值照抄;提供了地图 SVG 路径时内联使用并按 cx/cy 摆节点标签;先被一眼认出是同一张大屏。

3. **新建 coder.replica.user.md** — vars:{{requirement}}、{{answers}}、{{inventory}}、{{dataBlock}}、{{mapNote}}。

4. **新建 replica.inventory.system.md / replica.inventory.user.md** — 大屏读图精读专家。输入:大屏参考图(可能附局部放大裁剪图)+ 用户文字需求。输出 JSON:{"title","layout","panels":[{"name","position","content"}],"kpis":[],"colors","hasMap":bool,"mapAdcode":"如330000,无则空串","mapCities":[],"notes"}。强调:每段文字标签、每个数值与单位照抄原图,看不清标"约";配色给 hex 估计。user 文件 vars:{{requirement}}。

5. **新建 review.shot.system.md / review.shot.user.md** — 大屏验收员,双模式:给了参考图时把成品截图与参考图同视角对比(布局结构、面板缺失、数值一致、一眼认出);没给参考图时按检查表验收(溢出/裁切/数值超容器/图表空白/文字看不清/不像数据大屏品类)。只报确实影响观感和还原度的问题,最多 3 个。输出 {"issues":[{"title","detail"}]},title 大白话。user 文件 vars:{{requirement}}。

6. **修改 planner.system.md**(先读现有):输出 JSON 增加可选字段 "mapAdcode"(字符串)——用户需求涉及地图/地理分布且能判断到省级行政区时填对应 adcode(如浙江 330000),否则空串。不破坏现有字段与格式。

== server/package.json ==
dependencies 加 "sharp" 和 "playwright"(版本号查 npm 最新稳定版,用 ^ 语义化)。不要动 devDependencies 和 scripts。

完成后自检:cd ${REPO}/server && npm install && npx tsc --noEmit(replica.ts 自身不能有类型错误;orchestrator 等别人的文件此时报错不用管)。如果 npm install 网络失败,记录进 deviations 并保证代码逻辑正确。`,
  { label: 'A:replica-infra', phase: '基础设施', schema: REPORT_SCHEMA },
)
if (!sliceA) throw new Error('切片 A 未完成,replica.ts 接口缺失,无法继续')
log(`A 完成:${sliceA.filesChanged.length} 个文件`)

// ── B 与 C 并行:B 读 A 的真实产物做集成;C 做客户端与契约 ──
phase('服务端集成')
const sliceBPromise = agent(
  `你是服务端集成工程师,把 skill 双模式流程统一进 orchestrator 的创建流(有图无图都走)。${COMMON}

基础设施已由上游切片写好,先 Read 这些真实产物再动手(接口以代码为准):
- ${REPO}/server/src/replica.ts(精读/截图/GeoJSON 原语)
- ${REPO}/server/prompts/ 下的 coder.system.md(重写版)、coder.replica.*、replica.inventory.*、review.shot.*、planner.system.md(已加 mapAdcode)
上游接口摘要:${sliceA.apiSurface}

你的文件领地(只许动这些):server/src/orchestrator.ts、server/src/gateway.ts、server/src/routes.ts、server/src/store.ts、server/src/index.ts。

先通读 server/src/orchestrator.ts 的创建流(startCreateFlow/continueCreateToCoding/checkRepairAndFinish/callPlanner/callCoderCreate/callVisualReview/callCoderRepair/validateHtml)与 server/src/index.ts 静态托管,然后:

1. **统一流程**:有图无图都走 skill 流程,差别只在三处——精读阶段只有图才跑;Coder 的 system 有图时拼接 coder.replica.system(无图只用 coder.system);截图审查有图时带参考图对比(无图按检查表)。

2. 精读阶段(带图创建、vision 可用时,在模板匹配之前):
   - imageSize 读参考图尺寸,按"顶条/左栏/右栏/底部"4-6 个 Region 用 cropImageDataUrl 裁局部图。
   - 新增 callReplicaInventory:vision 角色 LLM,system=replica.inventory.system,user=replica.inventory.user({requirement}),content 带原图+裁剪图 image_url。JSON 容错提取沿用 gateway 现有手法。
   - 结果存 run.pending(类型在 ActiveRun/PendingRun 里扩字段,字段名英文小驼峰)。失败 → inventory=null 继续(不阻塞)。
   - 阶段标题用现有"分析参考图片",detail 实时报大白话进展("正在精读参考图细节…")。

3. 备料(有图无图都可能触发):
   - 有图:inventory.hasMap 且 mapAdcode 非空 → 取图转路径。
   - 无图:callPlanner 的返回里 mapAdcode 非空 → 同样取图转路径。
   - fetchGeoJson → geojsonToSvgPaths(宽640高520 decimate 2)→ 存 run.pending.mapPaths。任何一步失败 → pushAgent 一句大白话("地图素材没准备好,我按需求描述来画")并继续。

4. Coder 生成(callCoderCreate 改造):
   - 所有创建:coder.system(重写版)为 system。有 inventory 时追加 coder.replica.system,user 换 coder.replica.user({requirement,answers,inventory:JSON 文本,dataBlock,mapNote:有 mapPaths 时含路径 JSON 与用法说明}),content 附参考图 image_url(vision 可用才带)。
   - 无图创建:user 沿用现有 coder.create.user,但若 mapPaths 存在要拼上 mapNote 段。
   - 注意保持流式 onProgress 与 livePreview 行为不变。

5. 截图校验闭环(checkRepairAndFinish 升级,有图无图都生效):
   - probeReplicaEnv().ok 且 vision 可用时:renderShotDataUrl(run.html, 1920, 1080) → callShotReview(review.shot.system/user;content=截图,有参考图时加参考图)替代 callVisualReview 的文本审查(硬校验 validateHtml 照跑,两者问题合并去重)。
   - env 或 vision 不满足 → 现有 callVisualReview 文本审查兜底,行为不变。
   - 修复循环每轮修完重新截图复审;Issue.beforeShotUrl 填修复前真截图、fixed 后 afterShotUrl 填修复后真截图(替换现在的封面占位;走文本审查兜底路径时维持封面占位)。
   - 截图文件持久化到 server/data/shots/<dashId>/<issueId>-before.png / -after.png,routes/index.ts 加 express.static 托管 /shots,Issue 里存相对 URL。
   - 任何一环失败(截图失败/LLM 失败)→ 回落现有文本审查路径,不报错不阻塞。

6. 降级矩阵必须全部成立:(a) 全齐+有图→复刻+原图对比;(b) 全齐+无图→创作+截图检查表;(c) 无 vision(有无图)→文本审查;(d) 无 playwright(有无图)→文本审查;(e) 无图无 vision 无 playwright→完全等于现有流程。

7. 新建阶段序列:带图时阶段标题序列已有 '分析参考图片'/'视觉检查',沿用;无图序列不变;不要新增阶段类型,只换 detail 文案。

写完后 cd ${REPO}/server && npx tsc --noEmit 必须全绿(若 replica.ts 本身有上游遗留类型错误,可以直接修 replica.ts 的类型错误,但不许改它的导出签名)。`,
  { label: 'B:orchestrator', phase: '服务端集成', schema: REPORT_SCHEMA },
)

phase('客户端与契约')
const sliceCPromise = agent(
  `你是客户端与契约工程师,负责统一 skill 流程后的契约文档与客户端收尾。${COMMON}

背景:服务端正在把所有创建(有图无图)统一为 skill 流程:有图=复刻(精读参考图→备料→Coder 带图→截图+原图对比审查),无图=创作(按 design-language 设计规范生成→截图检查表审查);playwright/vision 缺失时降级为现有文本审查。Issue 的 beforeShotUrl/afterShotUrl 在截图路径下换成真截图(静态路径 /shots/...),文本兜底路径维持封面占位。契约类型(client/src/types/index.ts)预计无需改字段——你要核实这一点。

你的文件领地(只许动这些):API_CONTRACT_HTTP.md、client/src/components/**、client/src/stores/**、client/src/pages/**、CLAUDE.md。不许动 client/src/types/index.ts 和 client/src/api/**(若发现非改不可,写进 deviations 不要动手)。

任务:
1. Read client/src/components/workbench/(或右栏)里渲染 Issue 卡片的组件与 stores/session.ts,确认 beforeShotUrl/afterShotUrl 为真 URL 时展示正常(展开看修复前后对比);若现在是写死封面占位或压根没渲染这两张图,按现有卡片样式补上(组件 props 接收数据 + emit 事件,不直接 import store 的铁律要守;颜色只用设计令牌)。
2. Read API_CONTRACT_HTTP.md 全文,补充:创建统一走 skill 复刻/创作双模式流程的行为说明、attachments 与复刻模式的对应关系、/shots 静态路径、视觉检查升级为截图对比(含降级)的说明(若文中已有相关描述则就地更新)。语气与结构对齐现有文档。
3. 更新 CLAUDE.md:「核心架构-服务端结构」orchestrator 一行补充双模式统一流程与截图校验闭环关键词;「已知缺口(一期遗留)」把"Issue 截图对比用封面占位"改为已完成的事实描述;其他内容不动。
4. cd ${REPO}/client && npm run typecheck 必须全绿。`,
  { label: 'C:client-contract', phase: '客户端与契约', schema: REPORT_SCHEMA },
)

const [sliceB, sliceC] = await parallel([() => sliceBPromise, () => sliceCPromise])
if (!sliceB) throw new Error('切片 B(orchestrator 集成)未完成')
log(`B 完成:${sliceB.filesChanged.length} 个文件;C ${sliceC ? '完成' : '被跳过'}`)

// ── D:验证修复(唯一允许跨领地修文件的阶段)──────────────────
phase('验证修复')
log('D:安装依赖 + 双端 typecheck + smoke 全量验证')
const sliceD = await agent(
  `你是验证工程师,把这次大改修到全绿。${COMMON}

三个切片的产出都在工作树里:
- A(replica.ts+prompts+package.json):${sliceA.summary} | 偏差:${sliceA.deviations || '无'}
- B(orchestrator/gateway/routes 集成):${sliceB.summary} | 偏差:${sliceB.deviations || '无'}
- C(客户端+契约文档):${sliceC ? `${sliceC.summary} | 偏差:${sliceC.deviations || '无'}` : '被跳过,客户端可能未收尾,你要检查'}

按序执行,任何一步失败就修到通过(可以跨文件领地改代码,但不许改 client/src/types/index.ts 的字段名,不许回退用户的未提交改动):
1. cd ${REPO}/server && npm install(sharp/playwright 装上);然后 npx playwright install chromium(若网络失败,记录并继续——运行时降级兜底,不能因此挂掉)。
2. cd ${REPO}/server && npx tsc --noEmit 全绿。
3. cd ${REPO}/client && npm run typecheck 全绿。
4. cd ${REPO}/server && npm run smoke 通过。若 smoke 因新流程挂:先判断是 stub-llm 不支持新调用形态(带 image_url 的消息、精读 JSON、截图审查 JSON)还是 orchestrator 真 bug。stub 能力不够就扩 server/scripts/stub-llm.mjs(能识别带图消息并返回固定的精读 JSON/审查 JSON);orchestrator bug 就修 orchestrator。smoke 环境没有 playwright,必须走降级路径通过。
5. 最后通读 git diff 里 orchestrator.ts 的改动,复核五条降级路径:(a) 全齐+有图→复刻+原图对比;(b) 全齐+无图→创作+截图检查表;(c) 无 vision→文本审查;(d) 无 playwright→文本审查;(e) 无图无 vision 无 playwright→完全等于现有流程。确认无图创建的核心行为(阶段序列、流式预览、数据源取数)没有被改坏。

返回 summary 里明确写出:五条降级路径分别怎么验证的、playwright 浏览器是否装上了、smoke 结果。`,
  { label: 'D:verify-fix', phase: '验证修复', schema: REPORT_SCHEMA },
)
if (!sliceD) throw new Error('验证切片未完成')
log('D 完成,进入铁律审查')

// ── E:铁律审查(只读)────────────────────────────────────────
phase('铁律审查')
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['pass', 'findings'],
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'problem', 'severity'],
        properties: {
          file: { type: 'string' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
  },
}
const review = await agent(
  `你是契约铁律审查员,只读审查这次大改的 git diff,不修改任何文件。${COMMON}

执行 cd ${REPO} && git diff 看全部改动(server/skills/ 与 output/ 是既有产物,不在审查范围;.claude/ 也不在)。逐条核对:
1. wire.ts 是否只 import type 未改名;server 新增字段是否与 client/src/types/index.ts 逐字段一致。
2. 所有面向用户的字符串(agent 消息、阶段标题、卡片文案)是否大白话、有无技术术语。
3. prompt 是否全部落 server/prompts/*.md,TS 里有没有夹带大段 prompt。
4. 新 LLM 调用是否都有 try/catch + 看门狗 + 失败不阻塞。
5. 自包含约束:coder.system 与 coder.replica.system 是否都保留"禁止外部资源引用"。
6. coder.system.md 是否注入了 design-language 精要(骨架选型/色彩令牌/组件选型/高度预算/舞台缩放),有没有把 design-language.md 整篇照抄导致 prompt 臃肿。
7. 无图创建路径的既有行为(模板匹配、数据源取数、流式预览)是否被误伤;有无误伤用户未提交的在途改动(数据源/MCP 相关文件的无关改动)。
pass=true 的唯一标准:零 blocker。`,
  { label: 'E:contract-review', phase: '铁律审查', schema: REVIEW_SCHEMA },
)

return {
  slices: {
    A: { summary: sliceA.summary, files: sliceA.filesChanged },
    B: { summary: sliceB.summary, files: sliceB.filesChanged },
    C: sliceC ? { summary: sliceC.summary, files: sliceC.filesChanged } : null,
    D: { summary: sliceD.summary, files: sliceD.filesChanged },
  },
  contractReview: review,
}
