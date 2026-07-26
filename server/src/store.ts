/**
 * 持久化层 —— 全部 JSON 文件，不引入数据库。
 *
 * server/data/
 *   dashboards.json                     大屏卡片列表
 *   settings.json                       模型设置（单用户演示，Key 明文落本地文件）
 *   data-sources.json                   MCP 数据源列表（单用户演示，令牌/请求头值明文落本地文件）
 *   sessions/<dashId>.json              工作台会话快照（消息/阶段/版本/卡点…）
 *   events/<dashId>.jsonl               事件溯源，append-only，seq 单大屏递增
 *   previews/<dashId>/<verId>/index.html  构建产物（自包含 HTML）
 *   covers/*.png                        大屏封面（启动时从 client/public/covers 拷贝）
 *
 * 事件即界面：所有 SSE 事件先落 jsonl 再广播，重启后从 jsonl 恢复 seq 计数器，
 * 支持 Last-Event-ID 断线补发。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ClientEventMap, McpDataSource, ModelSettings } from './wire'

export interface StoredEvent {
  seq: number
  type: keyof ClientEventMap
  payload: ClientEventMap[keyof ClientEventMap]
  ts: number
}

type EventType = keyof ClientEventMap

/** 数据目录：默认 <server>/data，可用 DATA_DIR 覆盖（冒烟测试用独立目录） */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), 'data')

const DASHBOARDS_FILE = path.join(DATA_DIR, 'dashboards.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const DATA_SOURCES_FILE = path.join(DATA_DIR, 'data-sources.json')

export const dirs = {
  root: DATA_DIR,
  sessions: path.join(DATA_DIR, 'sessions'),
  events: path.join(DATA_DIR, 'events'),
  previews: path.join(DATA_DIR, 'previews'),
  covers: path.join(DATA_DIR, 'covers'),
  shots: path.join(DATA_DIR, 'shots')
}

/* ------------------------------ 基础读写 ------------------------------ */

function ensureDirs(): void {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------ Store ------------------------------ */

export type EventListener = (e: StoredEvent) => void

export class Store {
  /** 每个大屏的 seq 计数器（启动时从 jsonl 恢复） */
  private seqCounters = new Map<string, number>()
  /** SSE 订阅者：dashId -> listeners */
  private listeners = new Map<string, Set<EventListener>>()

  constructor() {
    ensureDirs()
    this.restoreSeqCounters()
    this.copyCoversOnce()
  }

  /* ---------- 事件（append-only jsonl + 内存广播） ---------- */

  private eventsFile(dashId: string): string {
    return path.join(dirs.events, `${dashId}.jsonl`)
  }

  private restoreSeqCounters(): void {
    if (!fs.existsSync(dirs.events)) return
    for (const f of fs.readdirSync(dirs.events)) {
      if (!f.endsWith('.jsonl')) continue
      const dashId = f.replace(/\.jsonl$/, '')
      let max = 0
      try {
        const lines = fs.readFileSync(path.join(dirs.events, f), 'utf8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const e = JSON.parse(line) as StoredEvent
            if (e.seq > max) max = e.seq
          } catch {
            /* 跳过坏行 */
          }
        }
      } catch {
        /* 文件读失败按 0 处理 */
      }
      this.seqCounters.set(dashId, max)
    }
  }

  /** 发射事件：seq 递增 → 落盘 jsonl → 广播给 SSE 订阅者 */
  emit<K extends EventType>(dashId: string, type: K, payload: ClientEventMap[K]): StoredEvent {
    const seq = (this.seqCounters.get(dashId) ?? 0) + 1
    this.seqCounters.set(dashId, seq)
    const e: StoredEvent = { seq, type, payload: payload as ClientEventMap[EventType], ts: Date.now() }
    fs.appendFileSync(this.eventsFile(dashId), JSON.stringify(e) + '\n', 'utf8')
    const subs = this.listeners.get(dashId)
    if (subs) for (const fn of subs) fn(e)
    return e
  }

  /** 读取 seq > lastSeq 的历史事件（Last-Event-ID 补发） */
  eventsSince(dashId: string, lastSeq: number): StoredEvent[] {
    const file = this.eventsFile(dashId)
    if (!fs.existsSync(file)) return []
    const out: StoredEvent[] = []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as StoredEvent
        if (e.seq > lastSeq) out.push(e)
      } catch {
        /* 跳过坏行 */
      }
    }
    return out
  }

  subscribe(dashId: string, fn: EventListener): () => void {
    let set = this.listeners.get(dashId)
    if (!set) {
      set = new Set()
      this.listeners.set(dashId, set)
    }
    set.add(fn)
    return () => set!.delete(fn)
  }

  /* ---------- 大屏卡片 ---------- */

  loadDashboards<T>(): T[] | null {
    return readJson<T[]>(DASHBOARDS_FILE)
  }

  saveDashboards(list: unknown[]): void {
    writeJson(DASHBOARDS_FILE, list)
  }

  /* ---------- 会话快照 ---------- */

  sessionFile(dashId: string): string {
    return path.join(dirs.sessions, `${dashId}.json`)
  }

  loadSession<T>(dashId: string): T | null {
    return readJson<T>(this.sessionFile(dashId))
  }

  saveSession(dashId: string, session: unknown): void {
    writeJson(this.sessionFile(dashId), session)
  }

  /* ---------- 设置 ---------- */

  loadSettings(): ModelSettings | null {
    return readJson<ModelSettings>(SETTINGS_FILE)
  }

  saveSettings(s: ModelSettings): void {
    writeJson(SETTINGS_FILE, s)
  }

  /* ---------- MCP 数据源（凭证明文落本地，单用户演示形态） ---------- */

  loadDataSources(): McpDataSource[] | null {
    return readJson<McpDataSource[]>(DATA_SOURCES_FILE)
  }

  saveDataSources(list: McpDataSource[]): void {
    writeJson(DATA_SOURCES_FILE, list)
  }

  /* ---------- 预览产物 ---------- */

  previewDir(dashId: string, versionId: string): string {
    return path.join(dirs.previews, dashId, versionId)
  }

  writePreview(dashId: string, versionId: string, html: string): void {
    const dir = this.previewDir(dashId, versionId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8')
  }

  copyPreview(srcFile: string, dashId: string, versionId: string): void {
    const dir = this.previewDir(dashId, versionId)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(srcFile, path.join(dir, 'index.html'))
  }

  readPreview(dashId: string, versionId: string): string | null {
    try {
      return fs.readFileSync(path.join(this.previewDir(dashId, versionId), 'index.html'), 'utf8')
    } catch {
      return null
    }
  }

  /* ---------- 删除大屏 ---------- */

  removeDashboardFiles(dashId: string): void {
    this.seqCounters.delete(dashId)
    this.listeners.delete(dashId)
    for (const p of [this.sessionFile(dashId), this.eventsFile(dashId)]) {
      try {
        fs.unlinkSync(p)
      } catch {
        /* 不存在则忽略 */
      }
    }
    fs.rmSync(path.join(dirs.previews, dashId), { recursive: true, force: true })
    fs.rmSync(path.join(dirs.shots, dashId), { recursive: true, force: true })
  }

  /* ---------- 封面：客户端上传的截图 ---------- */

  writeCover(dashId: string, buf: Buffer): void {
    fs.mkdirSync(dirs.covers, { recursive: true })
    fs.writeFileSync(path.join(dirs.covers, `${dashId}.png`), buf)
  }

  /* ---------- 截图：复刻流程的修复前/后对比图 ---------- */

  /** 把 PNG data URL 落盘到 shots/<dashId>/<name>.png，返回相对 URL（/shots/<dashId>/<name>.png） */
  writeShot(dashId: string, name: string, dataUrl: string): string {
    const m = /^data:image\/png;base64,([\s\S]+)$/.exec(dataUrl)
    const buf = Buffer.from(m ? m[1] : dataUrl, 'base64')
    const dir = path.join(dirs.shots, dashId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.png`), buf)
    return `/shots/${dashId}/${name}.png`
  }

  /* ---------- 封面：从 client/public/covers 拷贝（只读 client，不改动） ---------- */

  private copyCoversOnce(): void {
    const src = path.resolve(process.cwd(), '../client/public/covers')
    if (!fs.existsSync(src)) return
    for (const f of fs.readdirSync(src)) {
      const dst = path.join(dirs.covers, f)
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(src, f), dst)
    }
  }
}

export const store = new Store()
