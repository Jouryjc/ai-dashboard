/**
 * 工作台会话数据源（中区预览 + 右栏执行面板 + 顶栏版本）。
 * 打开/关闭工作台由本 store 统一负责（会联动 chat store）：
 *   const session = useSessionStore()
 *   await session.open(route.params.id)   // 进入工作台
 *   session.close()                        // 离开（返回首页）
 * 渲染：
 *   session.runStatus / session.statusText  // 顶栏与右栏窄条一句话
 *   session.stages                          // 阶段时间线（✓●○）
 *   session.issues                          // Issue 卡片（含第几次尝试）
 *   session.blocker                         // 卡点行动区（null = 无卡点，面板收起）
 *   session.versions                        // 版本时间线抽屉
 *   session.previewState / previewUrl       // 预览区三态
 * 操作：
 *   rollback / previewVersion / backToCurrent / publish / callAssist / endAssist / setResolution / togglePanel
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import { useChatStore } from './chat'
import {
  RUN_STATUS_LABEL,
  type AgentStep,
  type AssistSession,
  type Blocker,
  type Issue,
  type PreviewResolution,
  type PreviewState,
  type RunStatus,
  type Stage,
  type Version
} from '../types'

/** 已上传过封面的版本 ID（每个版本最多传一次，模块级，跨会话记忆） */
const coverUploadedVersions = new Set<string>()

/**
 * 封面自动更新（契约「追加」节）：
 * 仅 http 模式（VITE_API_BASE 存在）且 Electron 有 captureUrl 能力时，
 * previewReady 后延迟 ~1s 离屏截取预览 1920×1080 → uploadCover。
 * fire-and-forget，失败静默；浏览器 dev 模式直接跳过。
 */
function maybeUploadCover(dashboardId: string, versionId: string, previewUrl: string): void {
  if (!import.meta.env.VITE_API_BASE) return
  const capture = window.electronApp?.captureUrl
  if (typeof capture !== 'function') return
  if (coverUploadedVersions.has(versionId)) return
  setTimeout(() => {
    void (async () => {
      try {
        const dataUrl = await capture(previewUrl)
        // 成功上传后才记入"已传"：截图失败（超时/服务没起）允许下一次 previewReady 重试
        if (dataUrl) {
          await api.uploadCover(dashboardId, dataUrl)
          coverUploadedVersions.add(versionId)
        }
      } catch {
        /* 静默失败：封面没更新不影响主流程 */
      }
    })()
  }, 1000)
}

export const useSessionStore = defineStore('session', () => {
  /* ---------- state ---------- */
  /** 当前打开的大屏 ID（未打开 = null） */
  const dashboardId = ref<string | null>(null)
  /** 大屏名称（顶栏标题） */
  const dashboardName = ref('')
  /** 工作台运行状态（UX §7.1 五态） */
  const runStatus = ref<RunStatus>('idle')
  /** 阶段时间线 */
  const stages = ref<Stage[]>([])
  /** 执行轨迹（各阶段节点下的实时动作流："Agent 具体干了哪些事"） */
  const steps = ref<AgentStep[]>([])
  /** 问题列表（Issue Ledger 产品化） */
  const issues = ref<Issue[]>([])
  /** 当前卡点（null = 无卡点） */
  const blocker = ref<Blocker | null>(null)
  /** 版本时间线（新的在前） */
  const versions = ref<Version[]>([])
  /** 预览区状态：empty 占位引导 / building 遮罩不清空 / ready 就绪 */
  const previewState = ref<PreviewState>('empty')
  /** 预览内容地址（public/preview/ 下的页面） */
  const previewUrl = ref<string | null>(null)
  /** 正在查看的历史版本 ID（顶栏横幅"正在查看历史版本 v2"；null = 当前版本） */
  const viewingVersionId = ref<string | null>(null)
  /** true = 预览区正在实时展示生成中的部分页面（不盖"旧版本"遮罩，改显进度细条） */
  const previewBuildingLive = ref(false)
  /** 预览分辨率（仅缩放展示） */
  const resolution = ref<PreviewResolution>('1920x1080')
  /** 人工协助会话（null = 无协助） */
  const assistSession = ref<AssistSession | null>(null)
  /** 右栏执行面板是否折叠为窄条（空闲折叠、任务中自动展开，可手动切换） */
  const panelCollapsed = ref(true)

  /* ---------- getters ---------- */
  /** 运行状态大白话一句话 */
  const statusText = computed(() => RUN_STATUS_LABEL[runStatus.value])
  /** 当前进行中的阶段（● 那个；没有 = null） */
  const currentStage = computed<Stage | null>(() =>
    stages.value.find((s) => s.state === 'active') ?? null
  )
  /** 已完成阶段数 / 总数，如 "3/6"（空标题槽位是抹掉的尾巴，不计入） */
  const stageProgress = computed(() => {
    const titled = stages.value.filter((s) => s.title)
    const done = titled.filter((s) => s.state === 'done').length
    return `${done}/${titled.length}`
  })
  /** 是否有任何可用版本 */
  const hasVersion = computed(() => versions.value.length > 0)
  /** 发布申请已提交、正在等待审批（执行面板有「等待审批」进行中阶段） */
  const publishPending = computed(() =>
    stages.value.some((s) => s.id === 'st-publish' && s.state === 'active')
  )
  /** 是否可发布（空闲、有可用版本、且没有等待中的审批，UX §7.1 矩阵） */
  const canPublish = computed(() => runStatus.value === 'idle' && hasVersion.value && !publishPending.value)
  /** 是否可回退（生成中与人工协助中不可，其余可） */
  const canRollback = computed(() =>
    hasVersion.value && runStatus.value !== 'generating' && runStatus.value !== 'assisting'
  )
  /** 顶栏版本指示文案，如 "v3 · 已保存" / "生成中" */
  const versionLabel = computed(() => {
    if (runStatus.value === 'generating') return '生成中'
    const cur = versions.value.find((v) => v.isCurrent)
    return cur ? `${cur.label} · 已保存` : ''
  })

  /* ---------- 事件订阅 ---------- */
  let offs: Array<() => void> = []

  /* ---------- actions ---------- */
  /** 进入工作台：拉快照 + 订阅事件 + 联动对话区。幂等（重复打开同一大屏会先关再开）。 */
  async function open(id: string): Promise<void> {
    close()
    dashboardId.value = id

    const snap = await api.enterDashboard(id)
    dashboardName.value = snap.dashboard.name
    runStatus.value = snap.runStatus
    stages.value = snap.stages
    steps.value = snap.steps
    issues.value = snap.issues
    blocker.value = snap.blocker
    versions.value = snap.versions
    previewState.value = snap.preview.state
    previewUrl.value = snap.preview.url
    assistSession.value = snap.assistSession
    // 空闲折叠、任务中自动展开（C8）
    panelCollapsed.value = snap.runStatus === 'idle'

    const chat = useChatStore()
    chat.open(id, snap.messages)

    const forCurrent = (p: { dashboardId: string }) => p.dashboardId === dashboardId.value
    offs = [
      api.on('stage', (p) => {
        if (!forCurrent(p)) return
        const i = stages.value.findIndex((s) => s.id === p.stage.id)
        if (i >= 0) stages.value[i] = p.stage
        else stages.value.push(p.stage)
      }),
      api.on('issue', (p) => {
        if (!forCurrent(p)) return
        const i = issues.value.findIndex((x) => x.id === p.issue.id)
        if (i >= 0) issues.value[i] = p.issue
        else issues.value.push(p.issue)
      }),
      // 执行轨迹：新一轮开始（reset）先清空，再按 id 原位更新/追加
      api.on('step', (p) => {
        if (!forCurrent(p)) return
        if (p.reset) steps.value = []
        const i = steps.value.findIndex((x) => x.id === p.step.id)
        if (i >= 0) steps.value[i] = p.step
        else steps.value.push(p.step)
      }),
      api.on('blocker', (p) => {
        if (!forCurrent(p)) return
        blocker.value = p.blocker
      }),
      api.on('previewReady', (p) => {
        if (!forCurrent(p)) return
        previewState.value = 'ready'
        previewUrl.value = p.url
        previewBuildingLive.value = false
        viewingVersionId.value = null
        // 封面自动更新：http + Electron 时才真正执行，否则静默跳过
        maybeUploadCover(p.dashboardId, p.versionId, p.url)
      }),
      // 首次创建中：部分 HTML 实时预览（页面在预览区逐步长出来）
      api.on('previewBuilding', (p) => {
        if (!forCurrent(p)) return
        previewState.value = 'building'
        previewUrl.value = p.url
        previewBuildingLive.value = true
      }),
      api.on('versionAdded', (p) => {
        if (!forCurrent(p)) return
        versions.value = [p.version, ...versions.value.filter((v) => v.id !== p.version.id)]
      }),
      api.on('runStatus', (p) => {
        if (!forCurrent(p)) return
        runStatus.value = p.status
        // 任务开始/卡点/人工时自动展开面板；回到空闲保持用户当前选择
        if (p.status !== 'idle') panelCollapsed.value = false
        if (p.status === 'generating' && previewState.value !== 'empty') {
          // 构建中：保留旧版 + 遮罩，不清空
          previewState.value = 'building'
        }
      }),
      api.on('assist', (p) => {
        if (!forCurrent(p)) return
        assistSession.value = p.session
      })
    ]
  }

  /** 离开工作台：退订 + 通知后端停止推送 + 清空 + 关闭对话区 */
  function close(): void {
    offs.forEach((off) => off())
    offs = []
    if (dashboardId.value) void api.leaveDashboard(dashboardId.value)
    useChatStore().close()
    dashboardId.value = null
    dashboardName.value = ''
    runStatus.value = 'idle'
    stages.value = []
    steps.value = []
    issues.value = []
    blocker.value = null
    versions.value = []
    previewState.value = 'empty'
    previewUrl.value = null
    previewBuildingLive.value = false
    viewingVersionId.value = null
    resolution.value = '1920x1080'
    assistSession.value = null
    panelCollapsed.value = true
  }

  /** 回退到指定版本（生成一个新节点，历史保留；UI 先做二次确认再调） */
  async function rollback(versionId: string): Promise<void> {
    if (!dashboardId.value || !canRollback.value) return
    await api.rollback(dashboardId.value, versionId)
  }

  /** 预览历史版本（顶栏出现横幅 + 「返回当前」） */
  async function previewVersion(versionId: string): Promise<void> {
    if (!dashboardId.value) return
    await api.previewVersion(dashboardId.value, versionId)
    viewingVersionId.value = versionId
  }

  /** 退出历史版本预览，回到当前版本 */
  async function backToCurrent(): Promise<void> {
    if (!dashboardId.value) return
    await api.backToCurrentVersion(dashboardId.value)
    viewingVersionId.value = null
  }

  /** 发布（= 提交发布申请；UI 先弹确认再调） */
  async function publish(): Promise<void> {
    if (!dashboardId.value || !canPublish.value) return
    await api.publish(dashboardId.value)
  }

  /** 呼叫人工协助（可选一句话描述） */
  async function callAssist(note?: string): Promise<void> {
    if (!dashboardId.value) return
    await api.callAssist(dashboardId.value, note)
  }

  /** 结束协助，收回控制权 */
  async function endAssist(): Promise<void> {
    if (!dashboardId.value) return
    await api.endAssist(dashboardId.value)
  }

  /** 切换预览分辨率 */
  async function setResolution(r: PreviewResolution): Promise<void> {
    resolution.value = r
    if (dashboardId.value) await api.setPreviewResolution(dashboardId.value, r)
  }

  /** 折叠/展开右栏执行面板 */
  function togglePanel(collapsed?: boolean): void {
    panelCollapsed.value = collapsed ?? !panelCollapsed.value
  }

  return {
    dashboardId, dashboardName, runStatus, stages, steps, issues, blocker,
    versions, previewState, previewUrl, previewBuildingLive, viewingVersionId, resolution,
    assistSession, panelCollapsed,
    statusText, currentStage, stageProgress, hasVersion, canPublish, canRollback, versionLabel,
    publishPending,
    open, close, rollback, previewVersion, backToCurrent, publish,
    callAssist, endAssist, setResolution, togglePanel
  }
})
