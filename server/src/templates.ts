/**
 * 模板库 —— 布局与组件 demo 目录（来源：client/templates，启动时同步到 data/templates）。
 *
 * 用途（Planner 匹配模板环节）：
 * 1. 匹配：用户需求/参考图 → 选 1 个布局 + 若干组件类型（LLM 视觉比对 + 目录文本）
 * 2. 生成：命中的布局结构描述 + 组件 demo 图（vision）注入 Coder prompt，照模板还原
 */
import fs from 'node:fs'
import path from 'node:path'

/* ============================== 模板目录 ============================== */

export interface LayoutTemplate {
  id: string
  name: string
  /** 给 LLM 看的结构描述（匹配 + 生成共用） */
  structure: string
  /** 匹配关键词（非 vision 模式靠描述+标签匹配） */
  tags: string[]
  image: string // /templates/layouts/layoutU.png
}

export interface ComponentTemplate {
  id: string
  name: string
  description: string
  /** 匹配关键词 */
  tags: string[]
  /** demo 图（取每张目录第 1 张作代表） */
  image: string
}

export const LAYOUTS: LayoutTemplate[] = [
  {
    id: 'layoutU',
    name: 'U 型环绕',
    structure:
      '顶部通栏标题；左列 2 个信息图表面板（各占 6/24 列宽）；中央大主视觉区（占 12/24 列宽，一般放地图或设备可视化）；右列 3 个面板；底部一排 4 个小面板。整体呈 U 型环绕中央主视觉。',
    tags: ['地图', '主视觉', '环绕', '监控', '多面板', '综合', '全局'],
    image: '/templates/layouts/layoutU.png'
  },
  {
    id: 'layoutL',
    name: 'L 型左主视',
    structure:
      '顶部通栏标题；左侧超大主视觉区（占约 18/24 列宽，放地图或核心可视化）；右列 3 个信息图表面板（各占 6/24 列宽）；底部一排小面板（最小高度占 2/12 行）。主视觉偏左，右列与底排呈 L 型包围。',
    tags: ['地图', '主视觉', '大图', '重点突出', '单一主题', '汇报'],
    image: '/templates/layouts/layoutL.png'
  },
  {
    id: 'layoutI',
    name: 'I 型三栏',
    structure:
      '顶部通栏标题；经典三栏：左列 2 个信息图表面板、中央主视觉区（占 12/24 列宽）、右列 3 个面板，无底部横排。',
    tags: ['三栏', '简洁', '对称', '经典', '中等信息量'],
    image: '/templates/layouts/layoutI.png'
  }
]

export const COMPONENTS: ComponentTemplate[] = [
  {
    id: 'bar_charts',
    name: '柱状图',
    description: '深色底渐变柱：单系列渐变蓝柱（峰值带高亮数值标签）、双系列蓝绿对比柱、多系列堆叠柱；横轴为时间点，下方图例。',
    tags: ['柱状', '对比', '排行', '数量', '次数', '销量', '统计'],
    image: '/templates/components/bar_charts/1.png'
  },
  {
    id: 'numerical_indicators',
    name: '指标卡',
    description: '立体小图标 + 大号数字（带单位上标）+ 指标名称，如「99999+ 秒 / 整体可用率」。',
    tags: ['数字', '指标', 'KPI', '总数', '大数字', '概览'],
    image: '/templates/components/numerical_indicators/1.png'
  },
  {
    id: 'line_charts',
    name: '折线图',
    description: '蓝绿双折线：平滑曲线带面积渐变或普通折线，可带悬浮数值提示框和红色阈值虚线，横轴时间点。',
    tags: ['折线', '趋势', '走势', '变化', '时间', '曲线', '告警阈值'],
    image: '/templates/components/line_charts/3.png'
  },
  {
    id: 'pie_charts',
    name: '饼图',
    description: '环形多纳图（右侧图例带数值）、带引线百分比标注的饼图、3D 立体饼图；蓝/青/橙/灰配色。',
    tags: ['饼图', '占比', '比例', '分布', '构成', '环形'],
    image: '/templates/components/pie_charts/1.png'
  },
  {
    id: 'gauge_charts',
    name: '仪表盘',
    description: '指针式仪表盘、渐变弧线百分比（如 52%）、分段刻度弧线，右侧配「总数/已使用」图例说明。',
    tags: ['仪表', '使用率', '进度', '百分比', '负载', '容量'],
    image: '/templates/components/gauge_charts/1.png'
  },
  {
    id: 'relation_type',
    name: '关系拓扑',
    description: '节点连线拓扑图：立体设备图标 + 连线（按状态变色，带指标文字），悬浮显示节点详情卡；支持树状层级和区域分组。',
    tags: ['拓扑', '关系', '网络', '节点', '连线', '架构', '链路', '设备'],
    image: '/templates/components/relation_type/1.png'
  },
  {
    id: 'composite_type',
    name: '复合指标',
    description: '横向条形进度（按数值变色）、指标行（名称+百分比+明细文字）、环形进度、水球/竖条水位图。',
    tags: ['进度', '复合', '水位', '达成率', '完成度', '指标行'],
    image: '/templates/components/composite_type/1.png'
  }
]

/** 给 LLM 的目录文本（匹配用）：结构/样式描述 + 关键词标签（非 vision 模式的主要匹配依据） */
export function catalogText(): string {
  const layouts = LAYOUTS.map((l) => `- ${l.id}「${l.name}」（关键词：${l.tags.join('、')}）：${l.structure}`).join('\n')
  const components = COMPONENTS.map(
    (c) => `- ${c.id}「${c.name}」（关键词：${c.tags.join('、')}）：${c.description}`
  ).join('\n')
  return `【布局模板】\n${layouts}\n\n【组件模板】\n${components}`
}

/**
 * 关键词初筛（确定性）：统计每个模板在需求文本中的标签命中数，
 * 返回按相关度排序的 id 列表，作为给 LLM 的参考提示（不替模型做决定）。
 */
export function keywordHint(text: string): string {
  const score = (tags: string[]): number => tags.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0)
  const layouts = LAYOUTS.map((l) => ({ id: l.id, name: l.name, n: score(l.tags) })).sort((a, b) => b.n - a.n)
  const comps = COMPONENTS.map((c) => ({ id: c.id, name: c.name, n: score(c.tags) }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n)
  const lines: string[] = []
  if (layouts[0]?.n > 0) lines.push(`布局可能相关：${layouts.filter((l) => l.n > 0).map((l) => `${l.name}(${l.n})`).join('、')}`)
  if (comps.length > 0) lines.push(`组件可能相关：${comps.map((c) => `${c.name}(${c.n})`).join('、')}`)
  return lines.length > 0 ? `\n\n关键词初筛（仅供参考，以你的判断为准）：\n${lines.join('\n')}` : ''
}

/* ============================== 同步到 data 目录 ============================== */

/**
 * 把 client/templates 同步到 <dataDir>/templates（只拷贝缺失或更新的文件），
 * 返回实际可用的模板根目录；源目录不存在时返回 null（模板匹配自动降级为全自定义）。
 */
export function syncTemplates(dataDir: string): string | null {
  const src = path.resolve(dataDir, '../../client/templates')
  if (!fs.existsSync(src)) return null
  const dest = path.join(dataDir, 'templates')
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    )
  for (const file of walk(src)) {
    const rel = path.relative(src, file)
    const target = path.join(dest, rel)
    const needCopy =
      !fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(file).mtimeMs
    if (needCopy) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file, target)
    }
  }
  return dest
}

/**
 * 读模板图片为 dataURL（注入 Coder 视觉上下文用）；失败告警并返回 null。
 * templatesRoot 即 <dataDir>/templates；relPath 允许带 / 前缀和 templates/ 段（如模板目录里的
 * '/templates/layouts/layoutU.png'），这里统一剥掉，拼出 <templatesRoot>/layouts/layoutU.png。
 */
export function templateImageDataUrl(templatesRoot: string, relPath: string): string | null {
  const rel = relPath.replace(/^\/+/, '').replace(/^templates\//, '')
  const file = path.join(templatesRoot, rel)
  try {
    const buf = fs.readFileSync(file)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    // 读不到图 = 视觉参考静默降级为纯文本，必须留痕，否则"照模板还原"失效了都察觉不到
    console.warn(`[templates] 模板图片读取失败（按纯文本继续）：${file}`)
    return null
  }
}
