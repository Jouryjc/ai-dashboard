/**
 * 参考图复刻基础设施 —— 「照着参考图做大屏」能力的底层工具集。
 *
 * 提供五块能力：
 * - probeReplicaEnv()：探测本机图片裁剪（sharp）与截图浏览器（playwright chromium）
 *   是否可用，进程内只探一次，失败给大白话原因
 * - cropImageDataUrl() / imageSize()：参考图的裁剪与尺寸读取（局部放大精读用）
 * - renderShotDataUrl()：用无头浏览器把生成的 HTML 截成图（截图比对验收用）
 * - geojsonToSvgPaths()：DataV GeoJSON → 内联 SVG 路径（自包含地图，等距圆柱投影
 *   + 抽稀，逐行移植自 skills/big-screen-replica/scripts/geojson_to_svg.py）
 * - fetchGeoJson()：下载阿里 DataV 行政区划 GeoJSON（30s 超时）
 *
 * sharp 为静态依赖；playwright 动态加载，没装或浏览器没下载时不影响其他能力。
 */
import sharp from 'sharp'

/* ============================== 环境探测 ============================== */

export interface ReplicaEnv {
  ok: boolean
  sharpOk: boolean
  browserOk: boolean
  detail: string
}

/** 探测结果进程内缓存（探测要真的起一次浏览器，不便宜） */
let envCache: ReplicaEnv | null = null

async function probeSharp(): Promise<{ ok: boolean; detail: string }> {
  try {
    // 真的造一张 1×1 PNG，验证二进制可用而不只是包能加载
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } })
      .png()
      .toBuffer()
    return { ok: true, detail: '' }
  } catch (err) {
    return { ok: false, detail: `图片裁剪工具没装好（${errMessage(err)}）` }
  }
}

async function probeBrowser(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    await browser.close()
    return { ok: true, detail: '' }
  } catch (err) {
    return { ok: false, detail: `截图浏览器不可用（${errMessage(err)}）` }
  }
}

/** 探测 sharp 与 playwright chromium 是否可用；进程内缓存结果，失败给大白话 detail */
export async function probeReplicaEnv(): Promise<ReplicaEnv> {
  if (envCache) return envCache
  const [img, browser] = await Promise.all([probeSharp(), probeBrowser()])
  const problems = [img.detail, browser.detail].filter(Boolean)
  envCache = {
    ok: img.ok && browser.ok,
    sharpOk: img.ok,
    browserOk: browser.ok,
    detail: problems.length ? problems.join('；') : '图片裁剪和截图浏览器都就绪'
  }
  return envCache
}

/* ============================== 图片裁剪与尺寸 ============================== */

export interface Region {
  left: number
  top: number
  width: number
  height: number
}

/** 解析 data URL 为 Buffer（只认 base64） */
function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  const head = comma >= 0 ? dataUrl.slice(0, comma) : ''
  if (comma < 0 || !head.includes('base64')) {
    throw new Error('图片数据格式不对：需要 base64 的 data URL')
  }
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

function bufferToPngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`
}

/** 把 data URL 图片按区域裁剪，返回 PNG data URL 数组（与 regions 等长） */
export async function cropImageDataUrl(dataUrl: string, regions: Region[]): Promise<string[]> {
  const src = dataUrlToBuffer(dataUrl)
  const out: string[] = []
  for (const r of regions) {
    // 每次新建 sharp 实例：extract 是流水线状态，不能复用同一个实例
    const piece = await sharp(src)
      .extract({
        left: Math.max(0, Math.round(r.left)),
        top: Math.max(0, Math.round(r.top)),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height))
      })
      .png()
      .toBuffer()
    out.push(bufferToPngDataUrl(piece))
  }
  return out
}

/** 读 data URL 图片的像素尺寸 */
export async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(dataUrlToBuffer(dataUrl)).metadata()
  if (!meta.width || !meta.height) {
    throw new Error('读不出图片尺寸：文件可能损坏或格式不支持')
  }
  return { width: meta.width, height: meta.height }
}

/* ============================== HTML 截图 ============================== */

/** 给 Promise 套一个总超时，超时抛大白话错误 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 用 playwright 无头 chromium 把 HTML 渲染成 width×height 截图，返回 PNG data URL。
 * 浏览器不可用（包没装 / 浏览器没下载 / 启动失败）直接抛错，由调用方兜底。
 */
export async function renderShotDataUrl(html: string, width: number, height: number): Promise<string> {
  return withTimeout(renderShot(html, width, height), 120_000, '截图超时：页面 2 分钟还没截出来')
}

async function renderShot(html: string, width: number, height: number): Promise<string> {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (err) {
    throw new Error(`截图浏览器没装好，暂时截不了图（${errMessage(err)}）`)
  }
  let browser
  try {
    browser = await chromium.launch()
  } catch (err) {
    throw new Error(`截图浏览器启动失败，暂时截不了图（${errMessage(err)}）`)
  }
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1
    })
    try {
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load', timeout: 60_000 })
      const png = await page.screenshot({ type: 'png' })
      return bufferToPngDataUrl(png)
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

/* ============================== GeoJSON → SVG 路径 ============================== */

export interface MapPaths {
  [name: string]: { d: string; cx: number; cy: number }
}

type Position = number[]
type Ring = Position[]
type PolygonCoords = Ring[]

interface GeoGeometry {
  type?: unknown
  coordinates?: unknown
}

interface GeoFeature {
  properties?: Record<string, unknown> | null
  geometry?: GeoGeometry | null
}

/** 递归把坐标树里所有 [lng, lat] 点收集到 acc（移植 walk_coords） */
function walkCoords(coords: unknown, acc: Position[]): void {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    acc.push(coords as Position)
    return
  }
  if (Array.isArray(coords)) {
    for (const c of coords) walkCoords(c, acc)
  }
}

/** 统一成「多边形数组」（移植 polygons：Polygon 包一层，MultiPolygon 直接用） */
function polygonsOf(geom: GeoGeometry): PolygonCoords[] {
  if (geom.type === 'Polygon') return [geom.coordinates as PolygonCoords]
  if (geom.type === 'MultiPolygon') return geom.coordinates as PolygonCoords[]
  throw new Error(`地图数据里有不支持的地形类型：${String(geom.type)}`)
}

/**
 * GeoJSON → SVG 路径（等距圆柱投影 + 每 n 点抽稀，y 轴翻转适配屏幕坐标）。
 * 移植自 server/skills/big-screen-replica/scripts/geojson_to_svg.py：
 * 外接框等比缩放、pad 0.96 留白、path 精度 1 位小数、cx/cy 取 properties.center
 * 的投影点（没有则用全部投影点质心）。
 */
export function geojsonToSvgPaths(
  geojson: unknown,
  width: number,
  height: number,
  decimate: number = 2
): MapPaths {
  const pad = 0.96
  const feats = ((geojson as { features?: GeoFeature[] })?.features ?? []) as GeoFeature[]

  // 全部点求外接框
  const pts: Position[] = []
  for (const f of feats) {
    if (f.geometry?.coordinates) walkCoords(f.geometry.coordinates, pts)
  }
  if (!pts.length) return {}
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minx = Math.min(...xs)
  const maxx = Math.max(...xs)
  const miny = Math.min(...ys)
  const maxy = Math.max(...ys)

  const s = Math.min(width / (maxx - minx), height / (maxy - miny)) * pad
  const ox = (width - (maxx - minx) * s) / 2
  const oy = (height - (maxy - miny) * s) / 2

  const proj = (p: Position): [number, number] => [ox + (p[0] - minx) * s, oy + (maxy - p[1]) * s]

  const step = Math.max(1, Math.floor(decimate))
  const out: MapPaths = {}
  for (const f of feats) {
    if (!f.geometry) continue
    const props = f.properties ?? {}
    const name =
      (typeof props.name === 'string' && props.name) ||
      (typeof props.NAME === 'string' && props.NAME) ||
      'unknown'
    const ds: string[] = []
    const allProj: [number, number][] = []
    for (const poly of polygonsOf(f.geometry)) {
      for (const ring of poly) {
        const rp: [number, number][] = []
        for (let i = 0; i < ring.length; i += step) rp.push(proj(ring[i]))
        allProj.push(...rp)
        ds.push('M' + rp.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z')
      }
    }
    let cx: number
    let cy: number
    const center = props.center
    if (Array.isArray(center) && typeof center[0] === 'number' && typeof center[1] === 'number') {
      ;[cx, cy] = proj(center as Position)
    } else {
      cx = allProj.reduce((sum, p) => sum + p[0], 0) / allProj.length
      cy = allProj.reduce((sum, p) => sum + p[1], 0) / allProj.length
    }
    out[name] = {
      d: ds.join(''),
      cx: Math.round(cx * 10) / 10,
      cy: Math.round(cy * 10) / 10
    }
  }
  return out
}

/* ============================== DataV GeoJSON 下载 ============================== */

/** 下载 DataV GeoJSON（https://geo.datav.aliyun.com/areas_v3/bound/<adcode>_full.json），30s 超时，失败抛错 */
export async function fetchGeoJson(adcode: string): Promise<unknown> {
  const url = `https://geo.datav.aliyun.com/areas_v3/bound/${encodeURIComponent(adcode)}_full.json`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new Error(`地图数据下载失败：网络不通或超时（${errMessage(err)}）`)
  }
  if (!res.ok) {
    throw new Error(`地图数据下载失败：对方服务器返回了错误（状态 ${res.status}）`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error('地图数据下载失败：返回的内容不是有效的地图数据')
  }
}

/* ============================== 工具 ============================== */

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
