/**
 * 模板库 -- meta 自描述驱动（来源：client/templates，启动时同步到 data/templates）。
 *
 * 设计：每个模板 HTML 的 <head> 挂 <meta name="tpl-*"> 标签自描述元数据，
 * 启动时扫描所有 HTML、正则抠 meta 构建内存目录。HTML 既是产物又是元数据载体，
 * 加模板只需放文件 + 补 meta，不用改代码。HTML 全文启动时读入，注入 Coder prompt 还原样式。
 *
 * 用途（Planner 匹配模板环节）：
 * 1. 匹配：用户需求/参考图 -> 选 1 个布局 + 每个模块匹配组件模板（LLM 视觉比对 + 目录文本）
 * 2. 生成：命中的 layout HTML + 各模块组件 HTML 注入 Coder prompt，照模板还原
 */
import fs from 'node:fs'
import path from 'node:path'

/* ============================== 目录条目 ============================== */

export interface TemplateEntry {
  /** 模板 id（layoutU / bar_charts-1 / ...） */
  id: string
  /** layout | component */
  type: 'layout' | 'component'
  /** 展示名（给 LLM 看） */
  name: string
  /** 匹配关键词 */
  tags: string[]
  /** 适合的数据形态（metric/records/topology/...），空=不限 */
  dataKind: string[]
  /** 给 LLM 看的描述 */
  description: string
  /** 建议槽位（top/left/center/right/bottom），空=不限 */
  slot: string[]
  /** 相对 templates 根的路径（layouts/layoutU.html） */
  relPath: string
  /** 对应 PNG 路径（/templates/layouts/layoutU.png，给视觉模型看） */
  image: string
  /** 启动时读入的 HTML 全文（注入 Coder 用） */
  html: string
}

/** 内存目录（boot 时由 loadTemplateCatalog 填充） */
let catalog: TemplateEntry[] = []

/* ============================== meta 解析 ============================== */

/** 正则抠 <meta name="tpl-xxx" content="yyy">，无需 jsdom/cheerio */
const META_RE = /<meta\s+name="tpl-(id|type|name|tags|dataKind|desc|slot)"\s+content="([^"]*)">/gi

/** 把逗号分隔字符串切成数组（空串=空数组） */
function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 扫描 templatesRoot 下所有 .html，正则抠 meta 构建内存目录。
 * templatesRoot 为 null（client/templates 不存在）时清空目录，匹配自动降级为全自定义。
 * 每个条目的 HTML 全文在此一次性读入，运行时零 IO。
 */
export function loadTemplateCatalog(templatesRoot: string | null): void {
  catalog = []
  if (!templatesRoot || !fs.existsSync(templatesRoot)) return

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    )
  const htmlFiles = walk(templatesRoot).filter((f) => f.endsWith('.html'))

  for (const file of htmlFiles) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      console.warn(`[templates] 模板 HTML 读取失败：${file}`)
      continue
    }
    // 抠 meta
    const meta: Record<string, string> = {}
    let m: RegExpExecArray | null
    META_RE.lastIndex = 0
    while ((m = META_RE.exec(text)) !== null) {
      meta[m[1]] = m[2]
    }
    if (!meta.id || !meta.type) {
      console.warn(`[templates] 模板缺 tpl-id/tpl-type，跳过：${file}`)
      continue
    }
    if (meta.type !== 'layout' && meta.type !== 'component') {
      console.warn(`[templates] 模板 tpl-type 非法（${meta.type}），跳过：${file}`)
      continue
    }
    const relPath = path.relative(templatesRoot, file).replace(/\\/g, '/')
    // PNG 路径：HTML 同名 .png，挂 /templates 前缀（与 templateImageDataUrl 的剥前缀逻辑对齐）
    const image = `/templates/${relPath.replace(/\.html$/, '.png')}`
    catalog.push({
      id: meta.id,
      type: meta.type,
      name: meta.name || meta.id,
      tags: splitList(meta.tags || ''),
      dataKind: splitList(meta.dataKind || ''),
      description: meta.desc || '',
      slot: splitList(meta.slot || ''),
      relPath,
      image,
      html: text
    })
  }
  console.log(`[templates] 目录加载完成：${catalog.length} 个模板（layout ${catalog.filter((c) => c.type === 'layout').length} / component ${catalog.filter((c) => c.type === 'component').length}）`)
}

/* ============================== 目录查询 ============================== */

/** 按 id 查条目（替代旧 LAYOUTS.find / COMPONENTS.find） */
export function findTemplate(id: string): TemplateEntry | undefined {
  return catalog.find((c) => c.id === id)
}

/** 按 type 过滤（替代旧 LAYOUTS / COMPONENTS 直接遍历） */
export function templatesByType(type: 'layout' | 'component'): TemplateEntry[] {
  return catalog.filter((c) => c.type === type)
}

/** 目录总条数（匹配阶段进度文案用） */
export function catalogCount(): { layouts: number; components: number } {
  return {
    layouts: catalog.filter((c) => c.type === 'layout').length,
    components: catalog.filter((c) => c.type === 'component').length
  }
}

/* ============================== 给 LLM 的目录文本 ============================== */

/** 给匹配 LLM 看的目录文本：结构/样式描述 + 关键词标签 + 数据形态 + 槽位 */
export function catalogText(): string {
  const layouts = templatesByType('layout')
    .map((l) => `- ${l.id}「${l.name}」（关键词：${l.tags.join('、')}）：${l.description}`)
    .join('\n')
  const components = templatesByType('component')
    .map(
      (c) =>
        `- ${c.id}「${c.name}」（关键词：${c.tags.join('、')}）${c.dataKind.length ? `数据形态：${c.dataKind.join('/')}` : '数据形态：不限'}${c.slot.length ? `，建议槽位：${c.slot.join('/')}` : ''}：${c.description}`
    )
    .join('\n')
  return `【布局模板】\n${layouts}\n\n【组件模板】\n${components}`
}

/**
 * 关键词初筛（确定性）：统计每个模板在需求文本中的标签命中数，
 * 返回按相关度排序的 id 列表，作为给 LLM 的参考提示（不替模型做决定）。
 */
export function keywordHint(text: string): string {
  const score = (tags: string[]): number => tags.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0)
  const layouts = templatesByType('layout')
    .map((l) => ({ id: l.id, name: l.name, n: score(l.tags) }))
    .sort((a, b) => b.n - a.n)
  const comps = templatesByType('component')
    .map((c) => ({ id: c.id, name: c.name, n: score(c.tags) }))
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
