/**
 * 持久化层 —— 全部 JSON 文件，不引入数据库。
 *
 * server/data/
 *   dashboards.json                     大屏卡片列表
 *   settings.json                       模型设置（单用户演示，Key 明文落本地文件）
 *   data-sources.json                   MCP 数据源列表（单用户演示，令牌/请求头值明文落本地文件）
 *   publish-config.json                 发布配置（单用户演示，密钥明文落本地文件）
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
import type { ClientEventMap, McpDataSource, ModelSettings, PublishConfig } from './wire'
import type { ArtifactDraft } from './artifacts/types'

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
const PUBLISH_CONFIG_FILE = path.join(DATA_DIR, 'publish-config.json')

export const dirs = {
  root: DATA_DIR,
  sessions: path.join(DATA_DIR, 'sessions'),
  events: path.join(DATA_DIR, 'events'),
  previews: path.join(DATA_DIR, 'previews'),
  workspaces: path.join(DATA_DIR, 'workspaces'),
  covers: path.join(DATA_DIR, 'covers'),
  shots: path.join(DATA_DIR, 'shots')
}

/* ------------------------------ 基础读写 ------------------------------ */

function ensureDirs(): void {
  for (const d of Object.values(dirs)) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(d, 0o700)
    } catch {
      /* Windows may not expose POSIX permission bits. */
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

let writeSequence = 0

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeSequence += 1
  const tmp = `${file}.${process.pid}.${writeSequence}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : ''
    if (code !== 'EPERM' && code !== 'EEXIST') throw error
    // Windows may temporarily refuse replacing an existing file with rename.
    fs.copyFileSync(tmp, file)
    fs.unlinkSync(tmp)
  }
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows may not expose POSIX permission bits. */
  }
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error(`${label} 不合法`)
  }
  return value
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
    return path.join(dirs.events, `${safeId(dashId, '项目 ID')}.jsonl`)
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
    return path.join(dirs.sessions, `${safeId(dashId, '项目 ID')}.json`)
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

  /* ---------- 发布配置（云配置，密钥明文落本地，单用户演示形态） ---------- */

  loadPublishConfig(): PublishConfig | null {
    return readJson<PublishConfig>(PUBLISH_CONFIG_FILE)
  }

  savePublishConfig(c: PublishConfig): void {
    writeJson(PUBLISH_CONFIG_FILE, c)
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
    return path.join(
      dirs.previews,
      safeId(dashId, '项目 ID'),
      safeId(versionId, '版本 ID')
    )
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

  /* ---------- 版本数据来源元数据（与 index.html 同目录的 data-used.json） ---------- */

  /** 数据来源元数据文件名（与 index.html 同目录，removeDashboardFiles 删整棵树自动带走） */
  private static readonly META_FILE = 'data-used.json'

  writeVersionMeta(dashId: string, versionId: string, meta: unknown): void {
    const dir = this.previewDir(dashId, versionId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, Store.META_FILE), JSON.stringify(meta, null, 2), 'utf8')
  }

  readVersionMeta<T = unknown>(dashId: string, versionId: string): T | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.previewDir(dashId, versionId), Store.META_FILE), 'utf8')
      ) as T
    } catch {
      return null
    }
  }

  /* ---------- 版本真实数据（与 index.html 同目录的 data.json） ----------
   * 大屏 HTML 运行时 fetch('./data.json') 读取真实数值（不再由 LLM 写死）。
   * 发布/下载时由 inlineDataIntoHtml 把它内联进 HTML，保持单文件自包含。
   */

  /** 真实数据文件名（与 index.html 同目录，removeDashboardFiles 删整棵树自动带走） */
  private static readonly DATA_FILE = 'data.json'

  /** 写真实数据 data.json（结构化数组，未截断）到版本目录 */
  writeDataFile(dashId: string, versionId: string, data: unknown): void {
    const dir = this.previewDir(dashId, versionId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, Store.DATA_FILE), JSON.stringify(data, null, 2), 'utf8')
  }

  /** 读真实数据 data.json；不存在返回 null */
  readDataFile<T = unknown>(dashId: string, versionId: string): T | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.previewDir(dashId, versionId), Store.DATA_FILE), 'utf8')
      ) as T
    } catch {
      return null
    }
  }

  /** 读真实数据 data.json 原始字符串（发布/下载内联用，避免二次序列化丢精度）；不存在返回 null */
  readDataFileText(dashId: string, versionId: string): string | null {
    try {
      return fs.readFileSync(path.join(this.previewDir(dashId, versionId), Store.DATA_FILE), 'utf8')
    } catch {
      return null
    }
  }

  /* ---------- 多文件产物工作区 ---------- */

  artifactWorkspaceDir(projectId: string, revisionId: string): string {
    return path.join(
      dirs.workspaces,
      safeId(projectId, '项目 ID'),
      safeId(revisionId, '版本 ID')
    )
  }

  writeArtifactDraft(projectId: string, revisionId: string, draft: ArtifactDraft): string {
    const root = this.artifactWorkspaceDir(projectId, revisionId)
    fs.mkdirSync(root, { recursive: true })
    for (const [fileName, content] of Object.entries(draft.files)) {
      const normalized = fileName.replaceAll('\\', '/')
      const destination = path.resolve(root, normalized)
      const relative = path.relative(root, destination)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`产物文件路径不安全：${fileName}`)
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, content, 'utf8')
    }
    return root
  }

  writeArtifactEvidence(projectId: string, revisionId: string, evidence: unknown): void {
    writeJson(path.join(this.artifactWorkspaceDir(projectId, revisionId), '.evidence.json'), evidence)
  }

  readArtifactDraft(projectId: string, revisionId: string): ArtifactDraft | null {
    const root = this.artifactWorkspaceDir(projectId, revisionId)
    if (!fs.existsSync(root)) return null
    const files: Record<string, string> = {}
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(absolute)
        else if (entry.isFile()) {
          const relative = path.relative(root, absolute).replaceAll('\\', '/')
          files[relative] = fs.readFileSync(absolute, 'utf8')
        }
      }
    }
    walk(root)
    return { entryFile: 'index.html', files }
  }

  copyPreviewRevision(projectId: string, sourceRevisionId: string, targetRevisionId: string): void {
    const sourcePreview = this.previewDir(projectId, sourceRevisionId)
    if (!fs.existsSync(sourcePreview)) {
      throw new Error('要回退的预览产物不存在')
    }
    fs.cpSync(sourcePreview, this.previewDir(projectId, targetRevisionId), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
  }

  removePreviewRevision(projectId: string, revisionId: string): void {
    fs.rmSync(this.previewDir(projectId, revisionId), { recursive: true, force: true })
  }

  copyArtifactRevision(projectId: string, sourceRevisionId: string, targetRevisionId: string): void {
    const sourcePreview = this.previewDir(projectId, sourceRevisionId)
    const sourceWorkspace = this.artifactWorkspaceDir(projectId, sourceRevisionId)
    if (!fs.existsSync(sourcePreview) || !fs.existsSync(sourceWorkspace)) {
      throw new Error('要回退的多文件产物不完整')
    }
    this.copyPreviewRevision(projectId, sourceRevisionId, targetRevisionId)
    fs.cpSync(sourceWorkspace, this.artifactWorkspaceDir(projectId, targetRevisionId), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
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
    const safeDashId = safeId(dashId, '项目 ID')
    fs.rmSync(path.join(dirs.previews, safeDashId), { recursive: true, force: true })
    fs.rmSync(path.join(dirs.workspaces, safeDashId), { recursive: true, force: true })
    fs.rmSync(path.join(dirs.shots, safeDashId), { recursive: true, force: true })
  }

  /* ---------- 封面：客户端上传的截图 ---------- */

  writeCover(dashId: string, buf: Buffer): void {
    fs.mkdirSync(dirs.covers, { recursive: true })
    fs.writeFileSync(path.join(dirs.covers, `${safeId(dashId, '项目 ID')}.png`), buf)
  }

  /* ---------- 截图：复刻流程的修复前/后对比图 ---------- */

  /** 把 PNG data URL 落盘到 shots/<dashId>/<name>.png，返回相对 URL（/shots/<dashId>/<name>.png） */
  writeShot(dashId: string, name: string, dataUrl: string): string {
    const m = /^data:image\/png;base64,([\s\S]+)$/.exec(dataUrl)
    const buf = Buffer.from(m ? m[1] : dataUrl, 'base64')
    const safeDashId = safeId(dashId, '项目 ID')
    const safeName = safeId(name, '截图名称')
    const dir = path.join(dirs.shots, safeDashId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${safeName}.png`), buf)
    return `/shots/${safeDashId}/${safeName}.png`
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
