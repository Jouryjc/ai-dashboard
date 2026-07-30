/**
 * HTTP 适配层 —— 把 ClientApi 映射到真实服务端（契约见根目录 API_CONTRACT_HTTP.md）。
 *
 * - REST：全部"发指令"方法一一对应契约表格，立即 resolve，结果由 SSE 事件推回。
 * - SSE：enterDashboard 成功后建立 EventSource（/api/v1/dashboards/:id/events），
 *   按 event: <type> 分发给 on() 注册的 handler；同一时间只维护当前大屏的一条流，
 *   leaveDashboard / 切换大屏时关闭上一条。断线由 EventSource 自带
 *   Last-Event-ID 自动重连补齐，这里只负责对外广播连接状态。
 * - 连接状态：通过 window 事件 'api-connection'（detail.connected）广播，
 *   驱动 ReconnectBar（替代 mock 的 __mockDisconnect 模拟）。
 * - blob: 附件：sendMessage 前把 blob: URL 转 dataURL（服务端取不到 mock 的 blob URL），
 *   http(s)/data: URL 原样透传。
 * - previewUrl：契约里快照与 previewReady 事件给的是相对路径（/preview/...），
 *   对外一律拼上 baseUrl 成绝对地址，store/iframe 无需感知。
 */
import type {
  ClarificationAnswer,
  Dashboard,
  DataSourceProbeResult,
  McpDataSource,
  ModelSettings,
  PreviewResolution,
  ProbeResult,
  PublishConfig,
  Version
} from '../../types'
import type {
  ClientApi,
  ClientEventHandler,
  ClientEventMap,
  WorkbenchSnapshot
} from '../client'

type AnyHandler = (payload: never) => void

/** SSE 帧里会出现的事件（契约 SSE 节：event: <type>，data = ClientEventMap[type]）。
 *  必须与 ClientEventMap 的 key 一一对应，漏写会导致该事件在真实后端 SSE 收不到。 */
const EVENT_TYPES = [
  'message',
  'messageUpdated',
  'stage',
  'step',
  'issue',
  'blocker',
  'previewReady',
  'previewBuilding',
  'versionAdded',
  'runStatus',
  'dashboardUpdated',
  'assist',
  'graph',
  'publishProgress'
] as const satisfies ReadonlyArray<keyof ClientEventMap>

/** 连接状态广播事件名（WorkbenchPage 监听它驱动 ReconnectBar） */
export const CONNECTION_EVENT = 'api-connection'

export function createHttpClient(baseUrl: string): ClientApi {
  const base = baseUrl.replace(/\/+$/, '')

  const handlers = new Map<string, Set<AnyHandler>>()

  function emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): void {
    handlers.get(event)?.forEach((h) => h(payload as never))
  }

  /* ---------- 连接状态（驱动 ReconnectBar，UX §7.3） ---------- */
  let connected = true
  function setConnected(c: boolean): void {
    if (connected === c) return
    connected = c
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: { connected: c } }))
    }
  }

  /* ---------- REST 基础 ---------- */
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`请求失败（${res.status}）${text ? `：${text}` : ''}`)
    }
    if (res.status === 204) return undefined as T
    // 202 Accepted 等空响应体：先读文本，非空才按 JSON 解析
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  /** 相对路径（/preview/...）拼 baseUrl，绝对地址原样返回 */
  function absolutize(url: string | null): string | null {
    if (!url) return url
    return url.startsWith('/') ? `${base}${url}` : url
  }

  /** 封面 URL 同样由服务端托管（/covers/...），跨源渲染必须拼 baseUrl，否则上传的封面 404 */
  function fixDashboard(d: Dashboard): Dashboard {
    d.coverUrl = absolutize(d.coverUrl) ?? ''
    return d
  }

  /** 版本截图可能引用服务端封面（/covers/...），一并绝对化 */
  function fixVersion(v: Version): Version {
    v.screenshotUrl = absolutize(v.screenshotUrl) ?? ''
    return v
  }

  /* ---------- SSE：同一时间只维护当前大屏的一条流 ---------- */
  let eventSource: EventSource | null = null
  let streamingDashboardId: string | null = null

  function openStream(dashboardId: string): void {
    closeStream()
    streamingDashboardId = dashboardId
    const es = new EventSource(`${base}/api/v1/dashboards/${encodeURIComponent(dashboardId)}/events`)
    eventSource = es
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        const payload = JSON.parse((ev as MessageEvent<string>).data) as ClientEventMap[typeof type]
        if (type === 'previewReady') {
          const p = payload as ClientEventMap['previewReady']
          p.url = absolutize(p.url) as string
        }
        if (type === 'previewBuilding') {
          const p = payload as ClientEventMap['previewBuilding']
          p.url = absolutize(p.url) as string
        }
        if (type === 'dashboardUpdated') {
          const p = payload as ClientEventMap['dashboardUpdated']
          fixDashboard(p.dashboard)
        }
        if (type === 'versionAdded') {
          const p = payload as ClientEventMap['versionAdded']
          fixVersion(p.version)
        }
        emit(type, payload)
      })
    }
    es.onopen = () => setConnected(true)
    // EventSource 断线后自动带 Last-Event-ID 重连，这里只对外广播"正在重连"
    es.onerror = () => setConnected(false)
  }

  function closeStream(): void {
    eventSource?.close()
    eventSource = null
    streamingDashboardId = null
    // 离开工作台后不再有待重连的流，连接状态复位，避免提示条残留
    setConnected(true)
  }

  /* ---------- blob: 附件 → dataURL ---------- */
  function readBlobAsDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'))
      reader.readAsDataURL(blob)
    })
  }

  async function resolveAttachments(urls: string[]): Promise<string[]> {
    return Promise.all(
      urls.map(async (url) => {
        if (!url.startsWith('blob:')) return url // http(s)/data: 原样透传
        const blob = await (await fetch(url)).blob()
        return readBlobAsDataURL(blob)
      })
    )
  }

  /* ---------- ClientApi 实现 ---------- */

  return {
    // ---- 首页 ----
    async listDashboards(): Promise<Dashboard[]> {
      const list = await request<Dashboard[]>('GET', '/api/v1/dashboards')
      return list.map(fixDashboard)
    },
    async createDashboard(name: string): Promise<Dashboard> {
      const d = await request<Dashboard>('POST', '/api/v1/dashboards', { name })
      return fixDashboard(d)
    },
    async renameDashboard(id: string, name: string): Promise<void> {
      await request<Dashboard>('POST', `/api/v1/dashboards/${encodeURIComponent(id)}/rename`, { name })
    },
    async deleteDashboard(id: string): Promise<void> {
      if (streamingDashboardId === id) closeStream()
      await request<void>('DELETE', `/api/v1/dashboards/${encodeURIComponent(id)}`)
    },

    // ---- 工作台 ----
    async enterDashboard(id: string): Promise<WorkbenchSnapshot> {
      if (streamingDashboardId && streamingDashboardId !== id) closeStream()
      const snap = await request<WorkbenchSnapshot>(
        'POST',
        `/api/v1/dashboards/${encodeURIComponent(id)}/enter`
      )
      snap.preview.url = absolutize(snap.preview.url)
      fixDashboard(snap.dashboard)
      snap.versions.forEach(fixVersion)
      openStream(id)
      return snap
    },
    async leaveDashboard(id: string): Promise<void> {
      if (streamingDashboardId === id) closeStream()
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(id)}/leave`)
    },

    // ---- 对话 ----
    async sendMessage(dashboardId: string, text: string, attachmentUrls?: string[]): Promise<void> {
      const attachments = attachmentUrls?.length ? await resolveAttachments(attachmentUrls) : undefined
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/messages`, {
        text,
        attachments
      })
    },
    async answerClarification(
      dashboardId: string,
      messageId: string,
      answers: ClarificationAnswer[]
    ): Promise<void> {
      await request<void>(
        'POST',
        `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/messages/${encodeURIComponent(messageId)}/answers`,
        { answers }
      )
    },
    async chooseOption(dashboardId: string, optionId: string): Promise<void> {
      await request<void>(
        'POST',
        `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/options/${encodeURIComponent(optionId)}`
      )
    },
    async cancelAutoExec(dashboardId: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/auto-exec/cancel`)
    },

    // ---- 版本 ----
    async listVersions(dashboardId: string): Promise<Version[]> {
      const list = await request<Version[]>('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/versions`)
      return list.map(fixVersion)
    },
    async previewVersion(dashboardId: string, versionId: string): Promise<void> {
      await request<void>(
        'POST',
        `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/versions/${encodeURIComponent(versionId)}/preview`
      )
    },
    async backToCurrentVersion(dashboardId: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/versions/current`)
    },
    async rollback(dashboardId: string, versionId: string): Promise<void> {
      await request<void>(
        'POST',
        `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/versions/${encodeURIComponent(versionId)}/rollback`
      )
    },

    // ---- 预览 ----
    async setPreviewResolution(dashboardId: string, resolution: PreviewResolution): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/preview-resolution`, {
        resolution
      })
    },

    // ---- 封面 / 导出 ----
    async uploadCover(dashboardId: string, imageDataUrl: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/cover`, {
        image: imageDataUrl
      })
    },
    exportVersionUrl(dashboardId: string, versionId: string): string {
      return `${base}/api/v1/dashboards/${encodeURIComponent(dashboardId)}/versions/${encodeURIComponent(versionId)}/export`
    },

    // ---- 发布 ----
    async publish(dashboardId: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/publish`)
    },

    // ---- 人工协助 ----
    async callAssist(dashboardId: string, note?: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/assist`, { note })
    },
    async endAssist(dashboardId: string): Promise<void> {
      await request<void>('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/assist/end`)
    },

    // ---- 设置 ----
    async getSettings(): Promise<ModelSettings> {
      return request<ModelSettings>('GET', '/api/v1/settings')
    },
    async saveSettings(settings: ModelSettings): Promise<void> {
      await request<void>('PUT', '/api/v1/settings', settings)
    },
    async testConnection(settings?: ModelSettings): Promise<ProbeResult> {
      // 契约：probe 接受未保存的表单草稿；不传时用服务端已保存的设置
      try {
        const target = settings ?? (await request<ModelSettings>('GET', '/api/v1/settings'))
        return await request<ProbeResult>('POST', '/api/v1/model-gateway/probe', { settings: target })
      } catch (e) {
        // 契约承诺 probe 永不抛错；这里的兜底只防"连服务端本身都不通"
        const reason = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          supportsVision: false,
          message: '连不上：服务没响应',
          detail: `请求工作台服务失败：${reason}。请确认后端服务已启动、地址可访问。`
        }
      }
    },

    // ---- 数据源 ----
    async getDataSources(): Promise<McpDataSource[]> {
      return request<McpDataSource[]>('GET', '/api/v1/data-sources')
    },
    async saveDataSources(list: McpDataSource[]): Promise<void> {
      await request<void>('PUT', '/api/v1/data-sources', list)
    },
    async probeDataSource(source: McpDataSource): Promise<DataSourceProbeResult> {
      // 契约承诺 probe 永不抛错；这里的兜底只防"连服务端本身都不通"
      try {
        return await request<DataSourceProbeResult>('POST', '/api/v1/data-sources/probe', { source })
      } catch {
        return {
          ok: false,
          tools: [],
          message: '连不上：服务没响应',
          detail: null
        }
      }
    },

    // ---- 发布配置 ----
    async getPublishConfig(): Promise<PublishConfig> {
      return request<PublishConfig>('GET', '/api/v1/publish-config')
    },
    async savePublishConfig(config: PublishConfig): Promise<void> {
      await request<void>('PUT', '/api/v1/publish-config', config)
    },

    // ---- 事件订阅 ----
    on<K extends keyof ClientEventMap>(event: K, handler: ClientEventHandler<K>): () => void {
      let set = handlers.get(event)
      if (!set) {
        set = new Set()
        handlers.set(event, set)
      }
      const h = handler as AnyHandler
      set.add(h)
      return () => set.delete(h)
    }
  }
}
