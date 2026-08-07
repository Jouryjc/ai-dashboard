/**
 * ============================================================================
 * Mock 引擎 —— 剧本驱动的假后端（演示的灵魂，不需要任何真实服务）。
 *
 * - 初始数据见 ./data.ts（5 个预置大屏，覆盖四种状态徽标）
 * - 剧情编排见 ./scripts.ts（新建全流程 / 增量修改 / 卡点 / 人工协助 / 发布 / 回退）
 * - 本文件负责：会话状态持有、事件发射（含断线缓冲）、定时器分组管理、
 *   ClientApi 方法实现、window.__mockDisconnect() 调试钩子。
 *
 * 断线模拟（UX §7.3）：window.__mockDisconnect() 触发后 3 秒内所有事件进缓冲区，
 * 同时 window 派发 'api-connection' CustomEvent（detail.connected=false，与 HTTP 适配层
 * 的真实连接状态同一事件名）供顶栏显示"连接中断，正在重连…"；3 秒后按序补齐事件并派发
 * connected=true。
 * ============================================================================
 */
import type {
  AgentStep,
  ArtifactKind,
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
import { buildSeedSessions, dashboardTargetProfile, nextId, type SessionState } from './data'
import * as scripts from './scripts'
import type { Ctx } from './scripts'

type AnyHandler = (payload: never) => void

/** 事件发射器：mock 引擎内部用来推剧情（stores 只通过 on 订阅） */
export class MockEmitter {
  private handlers = new Map<string, Set<AnyHandler>>()

  on<K extends keyof ClientEventMap>(event: K, handler: ClientEventHandler<K>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    const h = handler as AnyHandler
    set.add(h)
    return () => set.delete(h)
  }

  emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): void {
    this.handlers.get(event)?.forEach((h) => h(payload as never))
  }
}

/** 默认模型设置 */
const DEFAULT_SETTINGS: ModelSettings = {
  provider: '公司内置',
  apiBase: 'https://llm.internal.example.com',
  apiKey: 'demo-key-not-a-real-credential',
  model: 'qwen2.5-72b-instruct',
  planner: { model: '', apiBase: '', apiKey: '' },
  coder: { model: '', apiBase: '', apiKey: '' },
  vision: { model: '', apiBase: '', apiKey: '' }
}

/** 默认数据源（演示用示例，probe 剧本见 probeDataSource） */
const DEFAULT_DATA_SOURCES: McpDataSource[] = [
  {
    id: 'ds-sales',
    name: '销售数据库',
    url: 'https://data.example.com/mcp',
    authType: 'none',
    token: '',
    headerName: '',
    accessKey: '',
    secretKey: '',
    enabled: true
  }
]

/** 默认发布配置（云配置，演示用空值，鼓励用户去填） */
const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
  endpoint: '',
  accessKey: '',
  secretKey: ''
}

/** 每个大屏的运行时（状态 + 定时器 + 队列） */
interface Runtime {
  state: SessionState
  ctx: Ctx
  /** 分组定时器：'main' 主剧情 / 'assist' 人工协助（endAssist 可整组取消） */
  timers: Map<string, Set<ReturnType<typeof setTimeout>>>
  queue: string[]
  resume: (() => void) | null
  autoTimer: ReturnType<typeof setTimeout> | null
  /** 新一轮已清空执行轨迹：下一个 step 事件要带 reset=true 让 stores 同步清空 */
  stepsResetPending: boolean
}

export function createMockClient(): ClientApi {
  const emitter = new MockEmitter()
  const sessions = new Map<string, Runtime>()
  let settings: ModelSettings = { ...DEFAULT_SETTINGS }
  let dataSources: McpDataSource[] = DEFAULT_DATA_SOURCES.map((s) => ({ ...s }))
  let publishConfig: PublishConfig = { ...DEFAULT_PUBLISH_CONFIG }

  /* ---------- 断线模拟（UX §7.3）：断线期间事件进缓冲，重连后按序补齐 ---------- */
  let disconnected = false
  const eventBuffer: Array<{ event: keyof ClientEventMap; payload: unknown }> = []

  function emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): void {
    if (disconnected) {
      eventBuffer.push({ event, payload })
      return
    }
    emitter.emit(event, payload)
  }

  function simulateDisconnect(): void {
    if (disconnected) return
    disconnected = true
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('api-connection', { detail: { connected: false } }))
    }
    setTimeout(() => {
      disconnected = false
      // 先补齐断线期间的事件，再通知"已重连"，UI 直接淡入最新状态
      const pending = eventBuffer.splice(0, eventBuffer.length)
      pending.forEach(({ event, payload }) => emitter.emit(event, payload as never))
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('api-connection', { detail: { connected: true } }))
      }
    }, 3000)
  }

  if (typeof window !== 'undefined') {
    ;(window as unknown as { __mockDisconnect?: () => void }).__mockDisconnect = simulateDisconnect
  }

  /* ---------- Runtime 构造 ---------- */

  function clearAllTimers(rt: Runtime): void {
    rt.timers.forEach((set) => set.forEach((t) => clearTimeout(t)))
    rt.timers.clear()
    if (rt.autoTimer) {
      clearTimeout(rt.autoTimer)
      rt.autoTimer = null
    }
  }

  function makeRuntime(state: SessionState): Runtime {
    const rt: Runtime = {
      state,
      ctx: null as unknown as Ctx,
      timers: new Map(),
      queue: [],
      resume: null,
      autoTimer: null,
      stepsResetPending: false
    }
    const dashId = state.dashboard.id

    rt.ctx = {
      s: state,
      stageSlots: state.stages.length,
      queue: rt.queue,

      after(ms, fn, group = 'main') {
        let set = rt.timers.get(group)
        if (!set) {
          set = new Set()
          rt.timers.set(group, set)
        }
        const t = setTimeout(() => {
          set.delete(t)
          fn()
        }, ms)
        set.add(t)
      },
      clearGroup(group) {
        const set = rt.timers.get(group)
        if (set) {
          set.forEach((t) => clearTimeout(t))
          set.clear()
        }
      },

      setStatus(status) {
        state.runStatus = status
        emit('runStatus', { dashboardId: dashId, status })
      },
      pushMessage(m) {
        state.messages.push(m)
        emit('message', { dashboardId: dashId, message: m })
      },
      updateMessage(m) {
        emit('messageUpdated', { dashboardId: dashId, message: m })
      },
      setStage(stage) {
        const i = state.stages.findIndex((x) => x.id === stage.id)
        if (i >= 0) state.stages[i] = stage
        else state.stages.push(stage)
        emit('stage', { dashboardId: dashId, stage })
      },
      resetSteps() {
        state.steps = []
        rt.stepsResetPending = true
      },
      startStep(stageId, title) {
        const step: AgentStep = {
          id: nextId('step'),
          stageId,
          title,
          detail: null,
          state: 'active',
          startedAt: Date.now(),
          finishedAt: null
        }
        const reset = rt.stepsResetPending
        rt.stepsResetPending = false
        if (reset) state.steps = []
        state.steps.push(step)
        emit('step', { dashboardId: dashId, step, reset })
        return step
      },
      finishStep(step, detail = null, stepState = 'done') {
        const done: AgentStep = { ...step, state: stepState, detail, finishedAt: Date.now() }
        const i = state.steps.findIndex((x) => x.id === done.id)
        if (i >= 0) state.steps[i] = done
        else state.steps.push(done)
        emit('step', { dashboardId: dashId, step: done, reset: false })
      },
      setIssue(issue) {
        const i = state.issues.findIndex((x) => x.id === issue.id)
        if (i >= 0) state.issues[i] = issue
        else state.issues.push(issue)
        emit('issue', { dashboardId: dashId, issue })
      },
      setBlocker(b) {
        state.blocker = b
        emit('blocker', { dashboardId: dashId, blocker: b })
      },
      addVersion(v, url) {
        state.versions.forEach((x) => (x.isCurrent = false))
        state.versions.unshift(v)
        state.versionUrls.set(v.id, url)
        state.dashboard.currentVersionLabel = v.label
        state.dashboard.currentRevisionId = v.id
        emit('versionAdded', { dashboardId: dashId, version: v })
      },
      upsertVersion(v) {
        const i = state.versions.findIndex((x) => x.id === v.id)
        if (i >= 0) state.versions[i] = v
        else state.versions.unshift(v)
        emit('versionAdded', { dashboardId: dashId, version: v })
      },
      previewReady(versionId, url) {
        state.preview = { state: 'ready', url }
        emit('previewReady', { dashboardId: dashId, versionId, url })
      },
      updateDashboard(patch) {
        Object.assign(state.dashboard, patch)
        state.dashboard.updatedAt = Date.now()
        emit('dashboardUpdated', { dashboard: { ...state.dashboard } })
      },
      setAssist(a) {
        state.assistSession = a
        emit('assist', { dashboardId: dashId, session: a })
      },
      setAutoExec(at, optionId) {
        if (rt.autoTimer) clearTimeout(rt.autoTimer)
        const delay = Math.max(0, at - Date.now())
        rt.autoTimer = setTimeout(() => {
          rt.autoTimer = null
          scripts.handleChooseOption(rt.ctx, optionId, true)
        }, delay)
      },
      clearAutoExec() {
        if (rt.autoTimer) {
          clearTimeout(rt.autoTimer)
          rt.autoTimer = null
        }
      },
      setResume(fn) {
        rt.resume = fn
      },
      takeResume() {
        const fn = rt.resume
        rt.resume = null
        return fn
      },
      now: () => Date.now()
    }
    return rt
  }

  /* ---------- 初始化：5 个预置大屏 + 物流卡点挂载 ---------- */
  for (const seed of buildSeedSessions()) {
    sessions.set(seed.dashboard.id, makeRuntime(seed))
  }
  const logistics = sessions.get('dash-logistics')
  if (logistics) scripts.attachLogisticsBlocker(logistics.ctx)

  function getRuntime(id: string): Runtime {
    let rt = sessions.get(id)
    if (!rt) {
      rt = makeRuntime({
        dashboard: {
          id,
          name: '未命名大屏',
          artifactKind: 'dashboard',
          targetProfile: dashboardTargetProfile(),
          status: 'completed',
          coverUrl: '',
          currentVersionLabel: null,
          currentRevisionId: null,
          updatedAt: Date.now()
        },
        runStatus: 'idle',
        messages: [],
        stages: [],
        steps: [],
        issues: [],
        blocker: null,
        versions: [],
        versionUrls: new Map(),
        preview: { state: 'empty', url: null },
        assistSession: null,
        theme: 'k8s'
      })
      sessions.set(id, rt)
    }
    return rt
  }

  function snapshotOf(state: SessionState): WorkbenchSnapshot {
    return {
      dashboard: { ...state.dashboard },
      runStatus: state.runStatus,
      messages: [...state.messages],
      stages: [...state.stages],
      steps: [...state.steps],
      issues: [...state.issues],
      blocker: state.blocker,
      versions: [...state.versions],
      preview: { ...state.preview },
      graph: null,
      assistSession: state.assistSession
    }
  }

  /* ---------- ClientApi 实现 ---------- */

  return {
    // ---- 首页 ----
    async listDashboards(): Promise<Dashboard[]> {
      return [...sessions.values()].map((rt) => ({ ...rt.state.dashboard }))
    },
    async createDashboard(name: string): Promise<Dashboard> {
      const id = nextId('dash')
      const rt = getRuntime(id)
      rt.state.dashboard.name = name.trim() || '未命名大屏'
      rt.state.dashboard.status = 'completed'
      return { ...rt.state.dashboard }
    },
    async createProject(name: string, artifactKind: ArtifactKind): Promise<Dashboard> {
      const id = nextId('dash')
      const rt = getRuntime(id)
      rt.state.dashboard.name = name.trim() || (artifactKind === 'dashboard' ? '未命名大屏' : '未命名页面')
      rt.state.dashboard.artifactKind = artifactKind
      rt.state.dashboard.targetProfile = artifactKind === 'dashboard'
        ? dashboardTargetProfile()
        : {
            framework: 'vue3',
            uiLibrary: 'idux',
            uiLibraryVersion: '2.11.0',
            viewportProfiles: ['1920x1080', '1366x768']
          }
      rt.state.dashboard.status = 'completed'
      return { ...rt.state.dashboard }
    },
    async renameDashboard(id: string, name: string): Promise<void> {
      const rt = sessions.get(id)
      if (rt) rt.ctx.updateDashboard({ name: name.trim() || rt.state.dashboard.name })
    },
    async deleteDashboard(id: string): Promise<void> {
      const rt = sessions.get(id)
      if (rt) {
        clearAllTimers(rt)
        sessions.delete(id)
      }
    },

    // ---- 工作台 ----
    async enterDashboard(id: string): Promise<WorkbenchSnapshot> {
      const rt = getRuntime(id)
      const snap = snapshotOf(rt.state)
      // dash-k8s 预置"生成中"：进入工作台自动续跑生成尾部（离开会清定时器，重进可再续）
      const mainTimers = rt.timers.get('main')
      if (id === 'dash-k8s' && rt.state.runStatus === 'generating' && (!mainTimers || mainTimers.size === 0)) {
        scripts.resumeCreateAtCheck(rt.ctx)
      }
      return snap
    },
    async leaveDashboard(id: string): Promise<void> {
      const rt = sessions.get(id)
      if (rt) clearAllTimers(rt)
    },

    // ---- 对话 ----
    async sendMessage(dashboardId: string, text: string, attachmentUrls?: string[]): Promise<void> {
      const rt = getRuntime(dashboardId)
      const ctx = rt.ctx
      const queued = rt.state.runStatus === 'generating'
      scripts.appendUserMessage(ctx, text, attachmentUrls ?? [], queued)
      if (queued) {
        rt.queue.push(text)
        return
      }
      switch (rt.state.runStatus) {
        case 'idle':
          if (rt.state.versions.length === 0)
            scripts.startCreateFlow(ctx, text, (attachmentUrls?.length ?? 0) > 0)
          else {
            const variant =
              dashboardId === 'dash-energy' ? 'retry_once' : dashboardId === 'dash-retail' ? 'stall' : 'smooth'
            scripts.startIncrementalFlow(ctx, text, variant)
          }
          break
        case 'awaiting_clarification':
          scripts.resolveClarificationWithText(ctx, text)
          break
        case 'blocked':
          scripts.handleFreeTextDuringBlocked(ctx, text)
          break
        case 'assisting':
          ctx.pushMessage({
            kind: 'agent',
            id: nextId('m'),
            createdAt: Date.now(),
            text: '支持人员正在处理，稍等一下～'
          })
          break
      }
    },
    async answerClarification(dashboardId: string, messageId: string, answers: ClarificationAnswer[]): Promise<void> {
      scripts.handleAnswerClarification(getRuntime(dashboardId).ctx, messageId, answers)
    },
    async chooseOption(dashboardId: string, optionId: string): Promise<void> {
      scripts.handleChooseOption(getRuntime(dashboardId).ctx, optionId)
    },
    async cancelAutoExec(dashboardId: string): Promise<void> {
      getRuntime(dashboardId).ctx.clearAutoExec()
    },

    // ---- 版本 ----
    async listVersions(dashboardId: string): Promise<Version[]> {
      return [...getRuntime(dashboardId).state.versions]
    },
    async previewVersion(dashboardId: string, versionId: string): Promise<void> {
      const rt = getRuntime(dashboardId)
      const url = rt.state.versionUrls.get(versionId)
      if (url) rt.ctx.previewReady(versionId, url)
    },
    async backToCurrentVersion(dashboardId: string): Promise<void> {
      const rt = getRuntime(dashboardId)
      const cur = rt.state.versions.find((v) => v.isCurrent)
      const url = cur ? rt.state.versionUrls.get(cur.id) : null
      if (cur && url) rt.ctx.previewReady(cur.id, url)
    },
    async rollback(dashboardId: string, versionId: string): Promise<void> {
      scripts.doRollback(getRuntime(dashboardId).ctx, versionId)
    },

    // ---- 预览 ----
    async setPreviewResolution(_dashboardId: string, _resolution: PreviewResolution): Promise<void> {
      // 仅影响预览缩放，store 本地处理即可，mock 无需动作
    },

    // ---- 封面 / 导出 ----
    async uploadCover(_dashboardId: string, _imageDataUrl: string): Promise<void> {
      // mock 模式封面仍用关键字示例图，上传为空操作
    },
    exportVersionUrl(dashboardId: string, versionId: string): string {
      // mock 没有真实的导出文件，返回该版本的预览地址（导出 = 下载预览页）
      return getRuntime(dashboardId).state.versionUrls.get(versionId) ?? ''
    },

    // ---- 发布 ----
    async publish(dashboardId: string): Promise<void> {
      const rt = getRuntime(dashboardId)
      if (rt.state.runStatus !== 'idle' || rt.state.versions.length === 0) return
      const cur = rt.state.versions.find((v) => v.isCurrent)
      if (!cur) return
      // mock 模式模拟真实发布进度（uploading → serving → success），推 publishProgress 事件给发布弹窗
      emit('publishProgress', { dashboardId, phase: 'uploading', message: '正在准备云端环境（创建/复用 CodeBox）…' })
      setTimeout(() => emit('publishProgress', { dashboardId, phase: 'uploading', message: '正在把大屏上传到云端…' }), 800)
      setTimeout(() => emit('publishProgress', { dashboardId, phase: 'serving', message: '正在云端启动服务并发布到公网…' }), 1800)
      setTimeout(() => {
        const publicUrl = `http://59.37.133.154:20000`
        // 成功：写 publicUrl + 标记已发布（复用 ctx 的 upsertVersion + updateDashboard）
        rt.ctx.upsertVersion({ ...cur, published: true, publicUrl })
        rt.ctx.updateDashboard({ status: 'published' })
        emit('publishProgress', { dashboardId, phase: 'success', message: `大屏已发布，公网访问地址：${publicUrl}`, publicUrl })
      }, 2800)
    },

    // ---- 人工协助 ----
    async callAssist(dashboardId: string, note?: string): Promise<void> {
      scripts.startAssistFlow(getRuntime(dashboardId).ctx, note)
    },
    async endAssist(dashboardId: string): Promise<void> {
      scripts.endAssistFlow(getRuntime(dashboardId).ctx)
    },

    // ---- 设置 ----
    async getSettings(): Promise<ModelSettings> {
      // 角色配置是嵌套对象，深拷贝避免表单 v-model 直接改到引擎里的存档
      return {
        ...settings,
        planner: { ...settings.planner },
        coder: { ...settings.coder },
        vision: { ...settings.vision }
      }
    },
    async saveSettings(s: ModelSettings): Promise<void> {
      settings = {
        ...s,
        planner: { ...s.planner },
        coder: { ...s.coder },
        vision: { ...s.vision }
      }
    },
    async testConnection(s?: ModelSettings): Promise<ProbeResult> {
      const target = s ?? settings
      // 模拟网络往返
      await new Promise((r) => setTimeout(r, 900))
      const badAddress = target.apiBase.includes('bad')
      const badKey = !target.apiKey.trim()
      if (badAddress || badKey) {
        const reason = badAddress && badKey ? '地址似乎不对，Key 也无效' : badAddress ? '地址似乎不对' : 'Key 无效'
        return {
          ok: false,
          supportsVision: false,
          message: `连不上：${reason}`,
          detail: `请求 ${target.apiBase || '(空地址)'} 连接失败：等待 10 秒无响应（连接超时）。常见原因：地址拼错、电脑不在公司内网或未连 VPN、Key 已过期。`
        }
      }
      if (target.model.toLowerCase().includes('text')) {
        return {
          ok: true,
          supportsVision: false,
          message: '连接成功。当前模型不支持看图片，布局检查将改用结构化检测，设计稿上传不可用',
          detail: null
        }
      }
      return {
        ok: true,
        supportsVision: true,
        message: '连接成功，支持图片理解，所有功能可用',
        detail: null
      }
    },

    // ---- 数据源 ----
    async getDataSources(): Promise<McpDataSource[]> {
      // 浅拷贝逐条复制，避免表单 v-model 直接改到引擎里的存档
      return dataSources.map((s) => ({ ...s }))
    },
    async saveDataSources(list: McpDataSource[]): Promise<void> {
      dataSources = list.map((s) => ({ ...s }))
    },
    async probeDataSource(source: McpDataSource): Promise<DataSourceProbeResult> {
      // 模拟网络往返
      await new Promise((r) => setTimeout(r, 600))
      if (!source.url.trim() || source.url.includes('bad')) {
        return {
          ok: false,
          tools: [],
          message: '连不上：地址似乎不对',
          detail: `请求 ${source.url || '(空地址)'} 连接失败：等待 10 秒无响应（连接超时）。常见原因：地址拼错、电脑不在公司内网或未连 VPN。`
        }
      }
      if (source.authType !== 'none' && !source.token.trim()) {
        return {
          ok: false,
          tools: [],
          message: '连不上：认证信息还没填',
          detail: '这个数据源要求认证，但令牌（或请求头的值）是空的，被拒绝了。'
        }
      }
      const tools = ['查指标', '查明细']
      return {
        ok: true,
        tools,
        message: `连接成功，发现 ${tools.length} 个可用工具`,
        detail: null
      }
    },

    // ---- 发布配置 ----
    async getPublishConfig(): Promise<PublishConfig> {
      // 返回拷贝，避免表单 v-model 直接改到引擎里的存档
      return { ...publishConfig }
    },
    async savePublishConfig(config: PublishConfig): Promise<void> {
      publishConfig = { ...config }
    },

    // ---- 事件订阅 ----
    on<K extends keyof ClientEventMap>(event: K, handler: ClientEventHandler<K>): () => void {
      return emitter.on(event, handler)
    }
  }
}
