/**
 * 共享工具函数 -- 从 orchestrator 提取的纯函数，供 loop-adapter 执行器复用。
 *
 * 这些函数不依赖 Runtime/ActiveRun 状态，是纯数据处理逻辑。
 */
import type { DataUseEntry } from '../wire'

/* ============================== 文本工具 ============================== */

export function truncate(text: string, max = 14): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 注入 prompt 前剥掉 http(s):// 开头的网址 */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, '（网址已省略）')
}

/** 按字节截断 UTF-8 文本 */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…（数据太长，已截断）`
}

/** 按需求关键词挑封面 */
export function coverFor(text: string): string {
  if (/k8s|K8s|K8S|容器|集群|服务器|监控|运维/.test(text)) return '/covers/dash-k8s.png'
  if (/销售|营收|订单|业绩|门店|日报/.test(text)) return '/covers/dash-sales.png'
  if (/物流|车辆|运输|快递|仓储/.test(text)) return '/covers/dash-logistics.png'
  if (/能耗|用电|电力|能源|碳/.test(text)) return '/covers/dash-energy.png'
  return '/covers/dash-retail.png'
}

/* ============================== 确定性校验 ============================== */

export function validateHtml(html: string): string[] {
  const problems: string[] = []
  if (!/<html[\s>]/i.test(html)) problems.push('不是完整的网页（缺少 html 标签）')
  if (!/<\/body>/i.test(html)) problems.push('页面没写完（缺少 </body>，可能生成时被长度限制截断）')
  if (!/<\/html>/i.test(html)) problems.push('页面没写完（缺少 </html>，可能生成时被长度限制截断）')
  if (!/<body[\s>]/i.test(html)) problems.push('页面没有正文内容（缺少 body 标签）')
  if (html.length < 2048) problems.push('内容太少，不像一个完整的大屏页面')
  if (/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html) || /url\(\s*["']?\s*https?:\/\//i.test(html))
    problems.push('引用了外部资源（大屏要求所有内容都写在一个文件里）')
  return problems
}

/** 确定性清洗：剥掉外部资源引用 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/(<(?:script|link|img|iframe|source)[^>]*?\s)(?:src|href)\s*=\s*["']\s*https?:\/\/[^"']*["']/gi, '$1data-removed-external=""')
    .replace(/url\(\s*["']?\s*https?:\/\/[^)"']*["']?\s*\)/gi, 'url(about:blank)')
}

/* ============================== 取数数据处理 ============================== */

/** 数据块截断上限 */
export const DATA_BLOCK_MAX_BYTES = Number(process.env.DATA_BLOCK_MAX_BYTES) || 8 * 1024

export type NormalizedKind = 'metric' | 'records' | 'topology' | 'catalog' | 'raw'
export interface NormalizedResult {
  kind: NormalizedKind
  rows?: unknown[]
  schema?: unknown
  meta?: unknown
  layers?: unknown
  catalog?: unknown[]
  raw?: string
}

export function normalizeToolResult(text: string, tool?: string): NormalizedResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { kind: 'raw', raw: text }
  }
  if (data == null || typeof data !== 'object') {
    return { kind: 'raw', raw: text }
  }
  if (Array.isArray(data)) {
    return { kind: 'catalog', catalog: data }
  }
  const obj = data as Record<string, unknown>
  if ('error' in obj) return { kind: 'raw', raw: text }
  const rows = Array.isArray(obj.rows) ? obj.rows : undefined
  const schema = obj.schema
  const meta = obj.meta
  const layers = Array.isArray(obj.layers) ? obj.layers : undefined

  if (layers || tool === 'query_topology_data') {
    return { kind: 'topology', layers: layers ?? [] }
  }
  if (tool === 'query_records') {
    return { kind: 'records', rows: rows ?? [], schema }
  }
  if (tool === 'query_metric') {
    return { kind: 'metric', rows: rows ?? [], schema, meta }
  }
  if (rows && meta && typeof meta === 'object') return { kind: 'metric', rows, schema, meta }
  if (rows) return { kind: 'records', rows, schema }
  return { kind: 'raw', raw: text }
}

function countRows(norm: NormalizedResult): number {
  if (norm.kind === 'topology') {
    const layers = (norm.layers ?? []) as Array<{ nodes?: unknown[] }>
    return layers.reduce((sum, l) => sum + (Array.isArray(l?.nodes) ? l.nodes.length : 0), 0)
  }
  if (norm.kind === 'catalog') {
    return Array.isArray(norm.catalog) ? norm.catalog.length : 0
  }
  if (norm.kind === 'metric' || norm.kind === 'records') {
    return Array.isArray(norm.rows) ? norm.rows.length : 0
  }
  return 0
}

export function toDataUseEntry(
  sourceName: string,
  call: { tool: string; purpose: string },
  norm: NormalizedResult
): DataUseEntry {
  return {
    source: sourceName,
    tool: call.tool,
    purpose: call.purpose || call.tool,
    kind: norm.kind,
    rows: countRows(norm),
    status: norm.kind === 'raw' ? 'fallback_raw' : 'ok'
  }
}

export function toFailedEntry(sourceName: string, call: { tool: string; purpose: string }, error: string): DataUseEntry {
  return {
    source: sourceName,
    tool: call.tool,
    purpose: call.purpose || call.tool,
    kind: 'raw',
    rows: 0,
    status: 'failed',
    error: truncate(error, 80)
  }
}

/** 单条取数结果（拼 dataBlock / dataFile 用） */
export interface DataItemInput {
  /** 数据源名称（来自 McpDataSource.name），用于 data.json 的 source 字段 */
  source?: string
  purpose: string
  text: string
  tool?: string
}

/** data.json 里单条数据项的形状（与 dataBlock 元素结构一致，仅多 source 字段） */
export interface DashboardDataItem {
  source?: string
  用途: string
  kind: NormalizedKind
  数据: NormalizedResult
}

/**
 * 把取数结果归一成结构化数组（data.json 落盘用）。
 * 与 buildDataBlock 共享同一归一逻辑，保证「LLM 在 prompt 里看到的数据形状」
 * =「HTML 运行时从 data.json 读到的形状」，零认知差。
 * 不截断（落盘用完整数据），仅 stripUrls 防御（数据里不应有网址）。
 */
export function buildDataItems(results: DataItemInput[]): DashboardDataItem[] {
  return results.map((r) => {
    const norm = normalizeToolResult(r.text, r.tool)
    const purpose = norm.kind === 'raw' ? `⚠️非标准结构 ${r.purpose}` : r.purpose
    return { source: r.source, 用途: purpose, kind: norm.kind, 数据: norm }
  })
}

/**
 * 把结构化数组重新拼回注入 prompt 的文本块（edit 流程从 data.json 回填 dataBlock 用）。
 * 截断逻辑与 buildDataBlock 一致，保证 edit 上下文与 create 等价。
 */
export function buildDataBlockFromItems(items: DashboardDataItem[]): string {
  const perItemMax = Math.max(1024, Math.floor(DATA_BLOCK_MAX_BYTES / Math.max(1, items.length)))
  const itemJsons = items.map((it) => {
    const json = stripUrls(JSON.stringify(it, null, 2))
    return truncateBytes(json, perItemMax)
  })
  return `${DATA_BLOCK_HEADER}\n[\n${itemJsons.join(',\n')}\n]`
}

/** dataBlock 头部说明文本（buildDataBlock / buildDataBlockFromItems 共用） */
const DATA_BLOCK_HEADER = `以下是从数据源取回的真实数据，已按结构归一，运行时必须从 data.json 读取其中的数值（不要写死）：
- 每条数据是一个 JSON 对象，"用途"说明这块数据画什么，"kind"标明数据结构类型，"数据"是归一后的内容。
- kind=metric（指标）：数值在"数据.rows"数组里，每行一个对象，字段名见"数据.schema"；"数据.meta.default_chart"提示画什么图，"数据.meta.unit"是单位。
- kind=records（明细）：每行一条记录在"数据.rows"里，字段含义见"数据.schema"的 display。
- kind=topology（拓扑）：分层结构在"数据.layers"里，每个 node 的 name/status/metrics 必须照抄。
- kind=catalog（指标清单）：不是画图数据，id 供理解指标含义，不要当数值写进大屏。
- kind=raw（非标准）：用途带⚠️，原文在"数据.raw"里，按需提取，无法识别就改用示例数据并标注。
- 这只是数据形状参考。真实数值由页面运行时 fetch('./data.json') 或读取内联 <script id="dashboard-data"> 得到，不要把这里的数值写死进 HTML。数据里不会出现网址。`

/** 拼注入 Coder prompt 的数据块（截断文本，给 LLM 看数据形状） */
export function buildDataBlock(results: DataItemInput[]): string {
  return buildDataBlockFromItems(buildDataItems(results))
}

/** 解析 list_metrics / list_models 返回的 {id, name, description} 列表 */
export function parseListItems(text: string): Array<{ id: string; name?: string; description?: string }> {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  const arr = Array.isArray(data) ? data
    : Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items
    : Array.isArray((data as { metrics?: unknown[] })?.metrics) ? (data as { metrics: unknown[] }).metrics
    : Array.isArray((data as { models?: unknown[] })?.models) ? (data as { models: unknown[] }).models
    : []
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
    .map((x) => ({
      id: String(x.id),
      name: typeof x.name === 'string' ? x.name : undefined,
      description: typeof x.description === 'string' ? x.description : undefined
    }))
}

/** 从 dataBlock 提取"指标名=数值"的精简摘要（防照抄模板数字） */
export function extractDataSummary(dataBlock: string): string {
  if (!dataBlock) return ''
  const idx = dataBlock.lastIndexOf('\n[')
  if (idx < 0) return ''
  let partial = dataBlock.slice(idx).trim()
  try {
    const arr = JSON.parse(partial) as Array<{ 用途?: string; 数据?: { rows?: unknown[] } }>
    const lines = arr
      .filter((it) => Array.isArray(it.数据?.rows) && it.数据!.rows!.length > 0)
      .map((it) => {
        const row = it.数据!.rows![0] as Record<string, unknown>
        const fields = Object.entries(row)
          .filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && /[\d.]/.test(v)))
          .map(([k, v]) => `${k}=${v}`)
          .join('、')
        return fields ? `${it.用途 ?? ''}：${fields}` : ''
      })
      .filter(Boolean)
    return lines.length > 0 ? lines.join('；') : ''
  } catch {
    return ''
  }
}

/**
 * 发布/下载时把 data.json 内联进 HTML，保持单文件自包含。
 * 在 <head> 后注入 <script type="application/json" id="dashboard-data">…</script>，
 * 页面 loader 优先读这个内联块，没有再 fetch('./data.json')（本地预览场景）。
 *
 * 防御：把内联串里的 </script 替换为 <\/script，避免数据含该串截断 script 标签。
 * 无 dataJson 或不是非空数组 -> 原样返回（纯视觉大屏、无数据源流程不内联）。
 */
export function inlineDataIntoHtml(html: string, dataJson: string | null): string {
  if (!dataJson) return html
  // 校验非空数组（与 fetch 落盘的 data.json 形状一致）
  let parsed: unknown
  try {
    parsed = JSON.parse(dataJson)
  } catch {
    return html
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return html

  const safe = dataJson.replace(/<\/(script)/gi, '<\\/$1')
  const tag = `<script type="application/json" id="dashboard-data">${safe}</script>`

  // 优先插在 <head> 之后；找不到 head 则插在 <html> 之后；都没有则前置
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${tag}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1${tag}`)
  }
  return `${tag}${html}`
}

/* ============================== HTML 补丁应用（repair 局部修复用） ============================== */

/** 单条补丁（LLM 输出的 search-and-replace 编辑指令） */
export interface HtmlEdit {
  /** 修改原因（给日志/反馈用） */
  reason?: string
  /** 要查找的原文片段：必须从当前 HTML 里原样复制，足够上下文保证唯一 */
  find: string
  /** 替换后的新片段 */
  replace: string
}

/** 单条补丁的应用结果 */
export interface HtmlEditResult {
  /** 原文片段预览（截断，给反馈用） */
  find: string
  /** 是否应用成功 */
  ok: boolean
  /** 失败原因（ok=false 时有） */
  reason: string
  /** 成功时为替换后的上下文片段（前后各 100 字）；失败时为最相似的原文片段（帮助 LLM 定位） */
  context: string
}

/** applyHtmlEdits 的返回值 */
export interface ApplyHtmlEditsResult {
  /** 应用后的 HTML（全部成功才更新；任一失败则返回原 html，不部分应用） */
  html: string
  /** 每条补丁的应用结果 */
  results: HtmlEditResult[]
  /** 是否全部成功 */
  allOk: boolean
}

/**
 * 应用 search-and-replace 补丁到 HTML（repair 局部修复用，仿 Aider/Claude Code 的 str_replace）。
 *
 * 规则：
 * - find 在 html 里找到且唯一 -> 替换，记录成功 + 替换后上下文片段
 * - find 找到多处 -> 不替换，反馈"找到 N 处匹配，需复制更多上下文"
 * - find 没找到 -> 不替换，反馈原文里最相似的片段（帮 LLM 知道哪抄错了）
 * - 任一补丁失败 -> 不部分应用，返回原 html + 失败反馈（保证一致性，让 LLM 据反馈重试）
 *
 * 顺序应用：每条补丁在前一条替换后的 html 上查找（前面的替换可能影响后面的匹配位置）。
 */
export function applyHtmlEdits(html: string, edits: HtmlEdit[]): ApplyHtmlEditsResult {
  let current = html
  const results: HtmlEditResult[] = []
  let allOk = true

  for (const edit of edits) {
    const find = edit.find ?? ''
    const replace = edit.replace ?? ''
    const findPreview = find.length > 60 ? `${find.slice(0, 30)}…${find.slice(-30)}` : find

    if (!find) {
      results.push({ find: findPreview, ok: false, reason: 'find 为空', context: '' })
      allOk = false
      continue
    }

    // 统计 find 在 current 里出现次数
    let count = 0
    let from = 0
    let firstIdx = -1
    while (true) {
      const idx = current.indexOf(find, from)
      if (idx < 0) break
      count++
      if (firstIdx < 0) firstIdx = idx
      from = idx + find.length
    }

    if (count === 0) {
      // 没找到：反馈原文里最相似的片段（取 find 的前 40 字在 current 里找最近匹配）
      const snippet = find.slice(0, 40)
      const near = current.indexOf(snippet)
      let context = ''
      if (near >= 0) {
        context = current.slice(Math.max(0, near - 30), near + snippet.length + 50)
      } else {
        // 退化：找 find 里最长的连续子串
        context = findSimilarSnippet(current, find)
      }
      results.push({
        find: findPreview, ok: false,
        reason: '在 HTML 里没找到这段原文（可能复制时有出入，请从当前 HTML 原样复制）',
        context
      })
      allOk = false
      continue
    }

    if (count > 1) {
      // 多处匹配：反馈出现位置附近的上下文，让 LLM 补更多上下文
      const ctx = current.slice(Math.max(0, firstIdx - 30), firstIdx + find.length + 50)
      results.push({
        find: findPreview, ok: false,
        reason: `找到 ${count} 处匹配，无法确定改哪处。请复制更多上下文（前后多带几行）让片段唯一`,
        context: ctx
      })
      allOk = false
      continue
    }

    // 唯一匹配：替换
    current = current.replace(find, replace)
    const repIdx = current.indexOf(replace)
    const context = repIdx >= 0
      ? current.slice(Math.max(0, repIdx - 100), repIdx + replace.length + 100)
      : ''
    results.push({ find: findPreview, ok: true, reason: '已替换', context })
  }

  // 任一失败：不部分应用，返回原 html（保证一致性）
  return { html: allOk ? current : html, results, allOk }
}

/**
 * 在 html 里找与 find 最相似的片段（简单版：取 find 的若干长子串，找第一个命中的周围上下文）。
 * 用于 find 匹配失败时给 LLM 反馈"原文里最像的是这段"，帮它定位抄错的地方。
 */
function findSimilarSnippet(html: string, find: string): string {
  // 从长到短取 find 的连续子串（步长 8），找第一个在 html 里出现的
  for (let len = Math.min(find.length, 50); len >= 12; len -= 8) {
    for (let i = 0; i + len <= find.length; i += 8) {
      const sub = find.slice(i, i + len)
      const idx = html.indexOf(sub)
      if (idx >= 0) {
        return html.slice(Math.max(0, idx - 30), idx + sub.length + 50)
      }
    }
  }
  return ''
}
