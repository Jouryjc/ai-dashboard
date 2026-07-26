// 大屏复刻 workflow:以 server/skills/big-screen-replica 为方法论的确定性流水线。
// 第一步(生成)严格按 skill 执行:读图精读 -> 备料(GeoJSON->SVG)-> 固定舞台 + scale-to-fit 单文件 HTML。
// 之后是无头浏览器截图校验闭环(验证/修复分离)+ 三视角终审。
//
// 用法:Workflow({ name: 'big-screen-replica', args: { image, outDir, width, height, maxFixRounds } })
//   image   参考图绝对路径(默认 stitch-reference/screenshots/dashboard.png)
//   outDir  产出目录(默认 output/replica-dashboard),index.html / shot.png / crops/ 都在这里
//   width/height 设计稿舞台尺寸(默认 1749x982,与参考图像素一致;预览端按 scale-to-fit 适配)

export const meta = {
  name: 'big-screen-replica',
  description: '按 big-screen-replica skill 复刻大屏参考图为自包含 HTML,含截图校验闭环与终审',
  whenToUse: '用户提供大屏参考图/设计稿,要高保真还原成 1920x1080(或原图尺寸)自包含 HTML 时',
  phases: [
    { title: '精读', detail: '全图 + region 裁剪,产出内容清单' },
    { title: '生成', detail: '按 skill 备料并写 index.html,首轮自检' },
    { title: '校验闭环', detail: '渲染截图对比原图,验证/修复分离,最多 3 轮修复' },
    { title: '终审', detail: '布局/内容/风格三视角独立评分' },
  ],
}

const REPO = '/home/jouryjc/ai-dashboard'
const SKILL_DIR = `${REPO}/server/skills/big-screen-replica`

const a = args || {}
const IMAGE = a.image || `${REPO}/stitch-reference/screenshots/dashboard.png`
const OUT_DIR = a.outDir || `${REPO}/output/replica-dashboard`
const W = a.width || 1749
const H = a.height || 982
const MAX_FIX = a.maxFixRounds || 3

const INVENTORY_SCHEMA = {
  type: 'object',
  required: ['title', 'layout', 'panels', 'kpis', 'colors', 'hasMap'],
  properties: {
    title: { type: 'string', description: '大屏主标题原文' },
    layout: { type: 'string', description: '整体布局描述:几栏、各栏宽度占比、从上到下分区' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'position', 'content'],
        properties: {
          name: { type: 'string' },
          position: { type: 'string', description: '左栏/中栏/右栏/顶部,及上下顺序' },
          content: { type: 'string', description: '面板内每段文字标签、每个数值与单位、图表类型,数值照抄原图' },
        },
      },
    },
    kpis: { type: 'array', items: { type: 'string' }, description: '顶部指标条每项:数值+单位+标签,照抄' },
    colors: { type: 'string', description: '背景/主色/强调色/警示色,尽量给 hex 估计值' },
    hasMap: { type: 'boolean' },
    mapAdcode: { type: 'string', description: '有地图时给出省份 adcode(如浙江 330000),无则空串' },
    mapCities: { type: 'array', items: { type: 'string' }, description: '图上标注的城市节点名' },
    notes: { type: 'string', description: '动画、装饰、特殊视觉元素等其他观察' },
  },
}

const GEN_SCHEMA = {
  type: 'object',
  required: ['htmlPath', 'selfCheck'],
  properties: {
    htmlPath: { type: 'string' },
    selfCheck: { type: 'string', description: '首轮自渲染自检发现并已修掉的问题' },
    mapSource: { type: 'string', description: '地图 SVG 来源:geojson 转换成功 / 下载失败手绘近似 / 无地图' },
  },
}

const ISSUES_SCHEMA = {
  type: 'object',
  required: ['pass', 'issues'],
  properties: {
    pass: { type: 'boolean', description: '无裁切无溢出、与原图同视角观感一致才为 true' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['region', 'problem', 'severity'],
        properties: {
          region: { type: 'string', description: '问题所在区域(哪个面板/哪条边)' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['score', 'summary'],
  properties: {
    score: { type: 'number', description: '1-10,10 为与原图几乎无法区分' },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const CROP_SNIPPET = `
裁剪方法(没有专门 crop 工具,用 PIL):
  mkdir -p ${OUT_DIR}/crops
  python3 -c "
from PIL import Image
im = Image.open('${IMAGE}')
im.crop((left, top, right, bottom)).save('${OUT_DIR}/crops/<name>.png')
"
坐标用原图原始像素。裁完用 Read 工具读裁剪图(它能看图)。`

// ── 阶段 1:精读 ──────────────────────────────────────────────
phase('精读')
log('精读参考图,建立内容清单')
const inventory = await agent(
  `你是大屏复刻的读图专家。参考图:${IMAGE}(${W}x${H})。
严格按 ${SKILL_DIR}/SKILL.md 第 1 节"读图精读"执行:
1. 先用 Read 工具看整图,把握三栏/面板布局。
2. 整图会降采样,小字必须 region 裁剪:对顶部指标条、左栏各面板、右栏各面板、底部表格各裁原分辨率区域(至少 4-6 块),逐块 Read 精读。${CROP_SNIPPET}
3. 数值一律照抄原图作为示例数据,不要自编"更合理"的数;看不清的标注"约"。
产出结构化内容清单(面板划分与占比、每段文字标签、每个数值与单位、配色、图表类型、地图城市节点)。`,
  { label: 'read:inventory', schema: INVENTORY_SCHEMA },
)
if (!inventory) throw new Error('精读阶段 agent 未返回结果')
log(`精读完成:${inventory.panels.length} 个面板,地图=${inventory.hasMap ? '有' : '无'}`)

// ── 阶段 2:生成(skill 第一步核心)────────────────────────────
phase('生成')
log('按 skill 备料并生成 index.html')
const gen = await agent(
  `你是大屏复刻的页面工程师。把参考图复刻成单文件 HTML,严格遵循 skill 方法论。

必读文件(先全部 Read):
- ${SKILL_DIR}/SKILL.md(总流程,执行其中第 3/4/5 节)
- ${SKILL_DIR}/references/big-screen-patterns.md(CSS 模式库,按参考图选用)
- 参考图 ${IMAGE},以及 ${OUT_DIR}/crops/ 下的精读裁剪图(全部 Read)

内容清单(精读阶段的产出,以此为准,数值照抄):
${JSON.stringify(inventory, null, 2)}

硬性要求:
1. 固定设计稿舞台:${W}x${H} 写死 .stage,按模式库"舞台缩放骨架"做 scale-to-fit(ResizeObserver),这是正确响应式。
2. 单文件自包含:禁止任何外部资源引用(无 CDN、无外链字体/图片/图标库),图标装饰纯 SVG/CSS 手绘。
3. 高度预算:header + 指标条 + 主区高度之和 <= ${H},动笔前先心算每栏各面板高度。
4. 地图:${inventory.hasMap ? `用 curl 下载 GeoJSON(curl -sL --max-time 30 https://geo.datav.aliyun.com/areas_v3/bound/${inventory.mapAdcode || '330000'}_full.json -o ${OUT_DIR}/geo.json),再 python3 ${SKILL_DIR}/scripts/geojson_to_svg.py ${OUT_DIR}/geo.json ${OUT_DIR}/map.json --width 640 --height 520 --decimate 2,把路径内联进 HTML;若下载失败,按原图轮廓手绘简化 SVG 近似并在 mapSource 说明。城市节点:${(inventory.mapCities || []).join('、')}` : '本图无地图,跳过'}。
5. 动画(飞线/呼吸)用 stroke-dashoffset/opacity,包 @media (prefers-reduced-motion: reduce) 降级。
6. 数字用窄体数字字体栈,中文走系统字体栈,文字用语义标签。
7. 右上约 190x44px 视为宿主控制区,不放可交互内容。

写到 ${OUT_DIR}/index.html。完成后首轮自检:
  python3 ${SKILL_DIR}/scripts/render_shot.py ${OUT_DIR}/index.html ${OUT_DIR}/shot.png --width ${W} --height ${H}
Read ${OUT_DIR}/shot.png 与原图对比,把整体/单栏溢出、文字裁切这类硬伤当场修掉(至少修一轮再交)。`,
  { label: 'gen:html' },
)
// 生成 agent 输出较长,不强制 schema;路径是约定的
log('index.html 已生成,进入截图校验闭环')

// ── 阶段 3:校验闭环(验证/修复分离)───────────────────────────
phase('校验闭环')
const verifyPrompt = (round) => `你是大屏复刻的验收员,只检查不修改。参考图:${IMAGE},被验页面渲染图:先执行
  python3 ${SKILL_DIR}/scripts/render_shot.py ${OUT_DIR}/index.html ${OUT_DIR}/shot.png --width ${W} --height ${H}
然后 Read ${OUT_DIR}/shot.png 与 Read ${IMAGE} 同视角对比(第 ${round} 次验收)。重点查:
- 整体/单栏溢出(底部被裁最常见)、卡片与表格行文字裁切、数值超出容器
- 地图节点/飞线/覆盖标签错位
- 与原图的布局结构、面板有无缺失、数值是否照抄原图
- 边缘:用 PIL 对 shot.png 顶条和底条各裁一块(裁到 ${OUT_DIR}/crops/verify-top.png / verify-bottom.png)复核
裁剪方法:python3 -c "from PIL import Image; Image.open('${OUT_DIR}/shot.png').crop((0,0,${W},160)).save('${OUT_DIR}/crops/verify-top.png')"
pass=true 的唯一标准:无裁切无溢出、面板与数值齐全、一眼认出是同一张大屏。小色差不算 blocker。`

const fixPrompt = (issues, round) => `你是大屏复刻的修复工程师。${OUT_DIR}/index.html 是 ${W}x${H} 固定舞台 + scale-to-fit 的大屏页面(参考图 ${IMAGE},内容清单:${JSON.stringify({ panels: inventory.panels, kpis: inventory.kpis })})。
验收员发现以下问题,逐条修复(用 Edit 精准改,不要重写整个文件;保持自包含与舞台缩放骨架不变):
${issues.map((it, i) => `${i + 1}. [${it.severity}] ${it.region}:${it.problem}`).join('\n')}
修完执行 python3 ${SKILL_DIR}/scripts/render_shot.py ${OUT_DIR}/index.html ${OUT_DIR}/shot.png --width ${W} --height ${H} 并 Read 截图确认修复生效且无新溢出。这是第 ${round} 轮修复。
最后返回一句话总结每条问题的处理结果。`

let report = null
let fixRounds = 0
for (let r = 1; r <= MAX_FIX + 1; r++) {
  report = await agent(verifyPrompt(r), { label: `verify:${r}`, schema: ISSUES_SCHEMA })
  if (!report) break
  if (report.pass) { log(`第 ${r} 次验收通过`); break }
  const blockers = report.issues.filter((i) => i.severity !== 'minor').length
  log(`第 ${r} 次验收:${report.issues.length} 个问题(${blockers} 个非 minor)`)
  if (r > MAX_FIX) break
  fixRounds = r
  await agent(fixPrompt(report.issues, r), { label: `fix:${r}` })
}
const verifyPass = !!(report && report.pass)

// ── 阶段 4:终审(三视角独立评分)──────────────────────────────
phase('终审')
const LENSES = [
  { key: 'layout', desc: '布局与结构:三栏占比、面板划分与有无缺失、溢出裁切、对齐' },
  { key: 'content', desc: '内容保真:每段文字标签、每个数值与单位是否照抄原图、图表类型是否一致' },
  { key: 'style', desc: '视觉风格:配色/发光/括号面板等装饰还原度、地图形态与节点飞线、整体观感是否一眼认出' },
]
const verdicts = await parallel(LENSES.map((l) => () =>
  agent(
    `你是大屏复刻终审评委,只从「${l.desc}」这一个视角打分。
Read 原图 ${IMAGE} 与成品渲染图 ${OUT_DIR}/shot.png(若不存在先执行 python3 ${SKILL_DIR}/scripts/render_shot.py ${OUT_DIR}/index.html ${OUT_DIR}/shot.png --width ${W} --height ${H}),必要时用 PIL 裁剪局部精读。
按 1-10 打分(10=该视角与原图几乎无法区分),列出扣分点。只评自己视角,别越界。`,
    { label: `judge:${l.key}`, schema: VERDICT_SCHEMA },
  ).then((v) => ({ lens: l.key, ...v })),
))
const valid = verdicts.filter(Boolean)
const avgScore = valid.length ? Math.round((valid.reduce((s, v) => s + v.score, 0) / valid.length) * 10) / 10 : 0
log(`终审均分 ${avgScore}/10`)

return {
  htmlPath: `${OUT_DIR}/index.html`,
  shotPath: `${OUT_DIR}/shot.png`,
  verifyPass,
  fixRounds,
  avgScore,
  verdicts: valid,
  remainingIssues: verifyPass ? [] : (report ? report.issues : []),
}
