/**
 * ============================================================================
 * Mock 数据 —— 初始大屏列表与每个大屏的初始工作台状态。
 *
 * 5 个预置大屏，覆盖四种状态徽标：
 *   dash-k8s       K8s 集群监控大屏   生成中（进入工作台会自动续跑生成尾部剧情）
 *   dash-sales     销售日报大屏       已发布（v1 打 ★）
 *   dash-logistics 物流追踪大屏       需要处理（数据源不可用卡点，blocker 由 scripts 挂上）
 *   dash-energy    能耗分析大屏       已完成（增量修改走"首次失败→倒计时自动重试"剧情）
 *   dash-retail    门店经营看板       已完成（增量修改走"停留超时（stall）卡点"剧情）
 *
 * 封面统一指向 public/covers/（home agent 从 stitch 截图拷贝），
 * 预览地址指向 public/preview/ 下本 agent 写的自包含 HTML。
 * ============================================================================
 */
import type {
  AgentStep,
  ArtifactManifest,
  AssistSession,
  Blocker,
  ChatMessage,
  Dashboard,
  Issue,
  PreviewState,
  RunStatus,
  Stage,
  TargetProfile,
  ValidationReport,
  Version
} from '../../types'

/** 自增 ID（消息 / 版本 / 大屏通用） */
let seq = 0
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

/** 预览产物主题（决定增量修改时 iframe 用哪个 HTML） */
export type PreviewTheme = 'k8s' | 'sales'

export function dashboardTargetProfile(): TargetProfile {
  return {
    framework: 'static-html',
    uiLibrary: 'none',
    uiLibraryVersion: null,
    viewportProfiles: ['1920x1080', '2560x1440']
  }
}

export function dashboardManifest(): ArtifactManifest {
  return {
    schemaVersion: 1,
    kind: 'dashboard',
    entryFile: 'index.html',
    files: ['index.html'],
    exportFormat: 'html'
  }
}

export function passedValidationReport(): ValidationReport {
  return {
    status: 'passed',
    gates: [{ id: 'mock-validation', title: '产物检查', status: 'passed', detail: '演示产物已登记' }]
  }
}

/** 每个大屏在 mock 引擎里的完整状态（enterDashboard 快照的来源） */
export interface SessionState {
  dashboard: Dashboard
  runStatus: RunStatus
  messages: ChatMessage[]
  stages: Stage[]
  /** 执行轨迹（各阶段节点下的动作流） */
  steps: AgentStep[]
  issues: Issue[]
  blocker: Blocker | null
  /** 版本时间线（新的在前） */
  versions: Version[]
  /** versionId -> 预览地址（版本切换 / 回退时 iframe 换 src 用） */
  versionUrls: Map<string, string>
  preview: { state: PreviewState; url: string | null }
  assistSession: AssistSession | null
  theme: PreviewTheme
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 预览地址工具：加 name 参数让静态 HTML 换标题，加 v 参数强制 iframe 刷新 */
export function previewUrl(theme: PreviewTheme, variant: 1 | 2, name: string, cacheKey: string | number): string {
  const file = theme === 'k8s' ? `k8s-v${variant}` : 'sales-v1'
  return `/preview/${file}.html?name=${encodeURIComponent(name)}&v=${cacheKey}`
}

/* ------------------------------ 小工厂 ------------------------------ */

function userMsg(text: string, at: number): ChatMessage {
  return { kind: 'user', id: nextId('m'), createdAt: at, text, attachmentUrls: [], queued: false }
}

function agentMsg(text: string, at: number): ChatMessage {
  return { kind: 'agent', id: nextId('m'), createdAt: at, text }
}

function systemMsg(text: string, at: number): ChatMessage {
  return { kind: 'system', id: nextId('m'), createdAt: at, text }
}

function stage(id: string, title: string, state: Stage['state'], startedAt: number | null, finishedAt: number | null): Stage {
  return { id, title, state, startedAt, finishedAt }
}

function step(id: string, stageId: string, title: string, detail: string | null, state: AgentStep['state'], startedAt: number, finishedAt: number | null): AgentStep {
  return { id, stageId, title, detail, state, startedAt, finishedAt }
}

function version(dashId: string, label: string, summary: string, createdAt: number, screenshotUrl: string, published: boolean, isCurrent: boolean): Version {
  return {
    id: `${dashId}-${label}`,
    label,
    summary,
    createdAt,
    screenshotUrl,
    published,
    isCurrent,
    manifest: dashboardManifest(),
    validationReport: passedValidationReport()
  }
}

/* ------------------------------ 预置数据 ------------------------------ */

/**
 * 生成 5 个大屏的初始状态。
 * 注意：dash-logistics 的卡点（问题卡片 + 右栏行动区）不在这里造，
 * 由 engine 初始化时调 scripts.attachLogisticsBlocker 挂上（选项走推荐规则表，保证文案唯一来源）。
 */
export function buildSeedSessions(now = Date.now()): SessionState[] {
  /* ---------- 1. K8s 集群监控大屏 · 生成中（快照卡在"视觉检查"进行中） ---------- */
  const k8sCover = '/covers/dash-k8s.png'
  const k8s: SessionState = {
    dashboard: {
      id: 'dash-k8s',
      name: 'K8s 集群监控大屏',
      artifactKind: 'dashboard',
      targetProfile: dashboardTargetProfile(),
      status: 'generating',
      coverUrl: k8sCover,
      currentVersionLabel: null,
      currentRevisionId: null,
      updatedAt: now - 2 * MIN
    },
    runStatus: 'generating',
    messages: [
      userMsg('帮我做一个服务器监控大屏，深色科技风', now - 4 * MIN),
      agentMsg('好的，我来帮你做。先理解一下你的需求…', now - 4 * MIN + 5_000),
      {
        kind: 'clarification',
        id: nextId('m'),
        createdAt: now - 3 * MIN - 30_000,
        intro: '开始之前，想跟你确认两件事',
        answered: true,
        questions: [
          {
            id: 'q-metrics',
            question: '监控哪些指标？',
            allowCustomInput: true,
            answer: 'CPU / 内存 / 网络',
            options: [
              {
                id: 'q-metrics-a',
                title: 'CPU / 内存 / 网络',
                consequence: '最常用的三样，一块屏全看到',
                recommended: true,
                recommendReason: '最常用组合，一次到位',
                riskLevel: 'low',
                autoExecuteAt: null
              },
              {
                id: 'q-metrics-b',
                title: '只要 CPU 和内存',
                consequence: '界面更简洁，网络指标不展示',
                recommended: false,
                recommendReason: null,
                riskLevel: 'low',
                autoExecuteAt: null
              }
            ]
          },
          {
            id: 'q-refresh',
            question: '数据多久自动刷新一次？',
            allowCustomInput: true,
            answer: '每 5 秒',
            options: [
              {
                id: 'q-refresh-a',
                title: '每 5 秒',
                consequence: '接近实时，适合盯告警',
                recommended: true,
                recommendReason: '监控场景选得最多',
                riskLevel: 'low',
                autoExecuteAt: null
              },
              {
                id: 'q-refresh-b',
                title: '每分钟',
                consequence: '更省资源，适合长期挂屏',
                recommended: false,
                recommendReason: null,
                riskLevel: 'low',
                autoExecuteAt: null
              }
            ]
          }
        ]
      },
      agentMsg('好的，监控 CPU / 内存 / 网络，每 5 秒刷新，深色科技风。正在找合适的组件…', now - 3 * MIN),
      agentMsg('页面写好了，正在检查视觉效果…', now - 30_000)
    ],
    stages: [
      stage('st-1', '理解需求', 'done', now - 4 * MIN, now - 3 * MIN - 30_000),
      stage('st-2', '查找组件', 'done', now - 3 * MIN, now - 2 * MIN - 30_000),
      stage('st-3', '编写页面', 'done', now - 2 * MIN - 30_000, now - 90_000),
      stage('st-4', '视觉检查', 'active', now - 30_000, null),
      stage('st-5', '修复问题', 'pending', null, null),
      stage('st-6', '生成预览', 'pending', null, null)
    ],
    steps: [
      step('step-k8s-1', 'st-1', '分析你的需求', '需求清楚了', 'done', now - 4 * MIN, now - 3 * MIN - 30_000),
      step('step-k8s-2', 'st-2', '和模板库比对：6 种布局、12 类组件', '命中「指挥中心三栏」、指标卡', 'done', now - 3 * MIN, now - 2 * MIN - 30_000),
      step('step-k8s-3', 'st-3', '编写页面', '写完了，共 4,213 字', 'done', now - 2 * MIN - 30_000, now - 90_000),
      step('step-k8s-4', 'st-4', '给页面截图', null, 'active', now - 30_000, null)
    ],
    issues: [],
    blocker: null,
    versions: [],
    versionUrls: new Map(),
    preview: { state: 'empty', url: null },
    assistSession: null,
    theme: 'k8s'
  }

  /* ---------- 2. 销售日报大屏 · 已发布 ---------- */
  const salesCover = '/covers/dash-sales.png'
  const salesV1 = version('dash-sales', 'v1', '初版完成', now - 2 * DAY, salesCover, true, false)
  const salesV2 = version('dash-sales', 'v2', '增加同比环比', now - DAY - 2 * HOUR, salesCover, false, false)
  const salesV3 = version('dash-sales', 'v3', '调整配色', now - DAY, salesCover, false, true)
  const sales: SessionState = {
    dashboard: {
      id: 'dash-sales',
      name: '销售日报大屏',
      artifactKind: 'dashboard',
      targetProfile: dashboardTargetProfile(),
      status: 'published',
      coverUrl: salesCover,
      currentVersionLabel: 'v3',
      currentRevisionId: 'dash-sales-v3',
      updatedAt: now - DAY
    },
    runStatus: 'idle',
    messages: [
      userMsg('做一个销售日报大屏', now - 2 * DAY),
      agentMsg('做好了！销售额、订单数、转化率都在上面了，右侧看看效果。', now - 2 * DAY + 3 * MIN),
      userMsg('加上同比和环比', now - DAY - 2 * HOUR),
      agentMsg('已加上同比、环比，每个指标卡右上角都能看到。', now - DAY - 2 * HOUR + 2 * MIN),
      systemMsg('发布申请已通过，v1 已发布', now - DAY - HOUR)
    ],
    stages: [],
    steps: [],
    issues: [],
    blocker: null,
    versions: [salesV3, salesV2, salesV1],
    versionUrls: new Map([
      [salesV1.id, previewUrl('sales', 1, '销售日报大屏', 1)],
      [salesV2.id, previewUrl('sales', 1, '销售日报大屏', 2)],
      [salesV3.id, previewUrl('sales', 1, '销售日报大屏', 3)]
    ]),
    preview: { state: 'ready', url: previewUrl('sales', 1, '销售日报大屏', 3) },
    assistSession: null,
    theme: 'sales'
  }

  /* ---------- 3. 物流追踪大屏 · 需要处理（卡点由 scripts.attachLogisticsBlocker 挂） ---------- */
  const logisticsCover = '/covers/dash-logistics.png'
  const logisticsV1 = version('dash-logistics', 'v1', '初版完成', now - 4 * DAY, logisticsCover, false, true)
  const logistics: SessionState = {
    dashboard: {
      id: 'dash-logistics',
      name: '物流追踪大屏',
      artifactKind: 'dashboard',
      targetProfile: dashboardTargetProfile(),
      status: 'needs_attention',
      coverUrl: logisticsCover,
      currentVersionLabel: 'v1',
      currentRevisionId: 'dash-logistics-v1',
      updatedAt: now - 3 * DAY
    },
    runStatus: 'blocked',
    messages: [
      userMsg('把车辆实时位置加到地图上', now - 3 * DAY),
      agentMsg('好的，正在连接车辆定位数据源…', now - 3 * DAY + 30_000)
    ],
    stages: [],
    steps: [],
    issues: [],
    blocker: null,
    versions: [logisticsV1],
    versionUrls: new Map([[logisticsV1.id, previewUrl('k8s', 1, '物流追踪大屏', 1)]]),
    preview: { state: 'ready', url: previewUrl('k8s', 1, '物流追踪大屏', 1) },
    assistSession: null,
    theme: 'k8s'
  }

  /* ---------- 4. 能耗分析大屏 · 已完成 ---------- */
  const energyCover = '/covers/dash-energy.png'
  const energyV1 = version('dash-energy', 'v1', '初版完成', now - 2 * DAY, energyCover, false, false)
  const energyV2 = version('dash-energy', 'v2', '新增分时电价分析', now - 5 * HOUR, energyCover, false, true)
  const energy: SessionState = {
    dashboard: {
      id: 'dash-energy',
      name: '能耗分析大屏',
      artifactKind: 'dashboard',
      targetProfile: dashboardTargetProfile(),
      status: 'completed',
      coverUrl: energyCover,
      currentVersionLabel: 'v2',
      currentRevisionId: 'dash-energy-v2',
      updatedAt: now - 5 * HOUR
    },
    runStatus: 'idle',
    messages: [
      userMsg('做一个能耗分析大屏', now - 2 * DAY),
      agentMsg('做好了！今日能耗、本月累计、同比都在上面了。', now - 2 * DAY + 3 * MIN),
      userMsg('加上分时电价分析', now - 5 * HOUR - 10 * MIN),
      agentMsg('加好了，峰平谷三段电价和用电量对比已经放上去了。', now - 5 * HOUR)
    ],
    stages: [],
    steps: [],
    issues: [],
    blocker: null,
    versions: [energyV2, energyV1],
    versionUrls: new Map([
      [energyV1.id, previewUrl('sales', 1, '能耗分析大屏', 1)],
      [energyV2.id, previewUrl('sales', 1, '能耗分析大屏', 2)]
    ]),
    preview: { state: 'ready', url: previewUrl('sales', 1, '能耗分析大屏', 2) },
    assistSession: null,
    theme: 'sales'
  }

  /* ---------- 5. 门店经营看板 · 已完成 ---------- */
  const retailCover = '/covers/dash-retail.png'
  const retailV1 = version('dash-retail', 'v1', '初版完成', now - DAY - HOUR, retailCover, false, true)
  const retail: SessionState = {
    dashboard: {
      id: 'dash-retail',
      name: '门店经营看板',
      artifactKind: 'dashboard',
      targetProfile: dashboardTargetProfile(),
      status: 'completed',
      coverUrl: retailCover,
      currentVersionLabel: 'v1',
      currentRevisionId: 'dash-retail-v1',
      updatedAt: now - DAY - HOUR
    },
    runStatus: 'idle',
    messages: [
      userMsg('做一个门店经营看板', now - DAY - HOUR - 10 * MIN),
      agentMsg('做好了！营业额、来客数、门店排行都在上面了。', now - DAY - HOUR)
    ],
    stages: [],
    steps: [],
    issues: [],
    blocker: null,
    versions: [retailV1],
    versionUrls: new Map([[retailV1.id, previewUrl('sales', 1, '门店经营看板', 1)]]),
    preview: { state: 'ready', url: previewUrl('sales', 1, '门店经营看板', 1) },
    assistSession: null,
    theme: 'sales'
  }

  return [k8s, sales, logistics, energy, retail]
}
