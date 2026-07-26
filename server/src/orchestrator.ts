/**
 * Orchestrator —— Run 状态机与全部行为语义。
 *
 * 流程骨架、阶段名、卡片规范、消息口吻对齐 client/src/api/mock/scripts.ts（Mock 剧本），
 * 但"剧本写死的内容"换成真实 LLM 生成：
 *   - Planner LLM：理解需求（+ 参考图，vision 可用才带图）→ 分析结论 + 是否需要澄清
 *     + 澄清问题（≤3 题、每题 2~3 选项、恰一个 ★推荐 + 推荐理由 + 后果说明）
 *   - Coder LLM：生成/修改完整自包含 HTML（1920×1080，inline SVG/CSS/JS，
 *     禁止任何外部资源引用 —— 硬约束，prompt 强调 + 确定性校验拦截）
 *   - 确定性校验失败 → Issue + LLM 修复（≤2 次）→ 再失败发问题处理卡片
 *     （推荐规则表：首次失败 ★重试 + 10 秒倒计时 autoExecuteAt；3 次失败 ★人工；
 *     回退类永不自动执行）
 *   - 大模型调用失败（连不上/超时/JSON 解析失败）→ 问题处理卡片
 *     （★推荐"让 AI 再试一次"，另给"检查模型设置""呼叫人工"），不许静默转圈
 *
 * Run 状态机五态用客户端契约的 RunStatus：
 *   idle / generating / awaiting_clarification / blocked / assisting
 * 生成中消息排队（queued:true），当前 Run 结束后合并成一条继续；
 * 倒计时自动执行（autoExecuteAt）由服务端定时器到点自动 chooseOption；
 * 发布 = 5 秒审批模拟；回退 = 复制产物生成新节点；协助 = 客服小李模拟流水。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dirs, store } from './store'
import * as gw from './gateway'
import { COMPONENTS, LAYOUTS, catalogText, keywordHint, syncTemplates, templateImageDataUrl } from './templates'
import { prompt } from './prompts'
import type {
  AssistSession,
  Blocker,
  CardOption,
  ChatMessage,
  ClarificationAnswer,
  ClarificationMessage,
  ClarificationQuestion,
  Dashboard,
  Issue,
  ModelSettings,
  PreviewResolution,
  ProblemMessage,
  RunStatus,
  Stage,
  Version,
  WorkbenchSnapshot
} from './wire'

/* ============================== 内部状态 ============================== */

/** 一次"生成 / 修改"任务的可持久化描述（重启后可据此重建续跑） */
interface PendingRun {
  kind: 'create' | 'edit'
  /** 用户需求 / 修改指令（排队消息已合并） */
  text: string
  /** 附件（dataURL 或 http(s) URL） */
  attachments: string[]
  /** 澄清回答汇总（已回答过澄清时带上） */
  answersSummary: string
  /** 当前卡在等什么 */
  awaiting: 'clarification' | 'problem' | 'llm' | null
  clarificationMessageId: string | null
  /** 本轮校验失败累计次数（决定推荐规则表场景） */
  failCount: number
  issueId: string | null
  /** 模板匹配决策（null = 还没做过匹配） */
  template?: TemplateDecision | null
}

/** 模板匹配环节的结论 */
interface TemplateDecision {
  layoutId: string | null
  componentIds: string[]
  /** false = 用户在"没有匹配"卡片里确认了自定义生成 */
  useTemplate: boolean
}

/** 工作台会话快照（sessions/<id>.json 落盘内容） */
interface SessionData {
  dashboard: Dashboard
  runStatus: RunStatus
  messages: ChatMessage[]
  stages: Stage[]
  issues: Issue[]
  blocker: Blocker | null
  versions: Version[]
  /** 版本产物相对路径（/preview/<dashId>/<verId>/index.html） */
  versionUrls: Record<string, string>
  preview: { state: 'empty' | 'building' | 'ready'; url: string | null }
  assistSession: AssistSession | null
  previewResolution: PreviewResolution
  pendingRun: PendingRun | null
}

/** 运行中任务的内存态（不落盘） */
interface ActiveRun {
  pending: PendingRun
  /** 最新一版生成/修复出的 HTML（协助修好时做确定性清洗用） */
  html: string
  /** 校验失败 + LLM 修复的重试闭包（问题卡片"让 AI 再试一次"触发） */
  retryRepair: (() => void) | null
  /** LLM 调用失败的重试闭包（"让 AI 再试一次"触发） */
  retryLlm: (() => void) | null
  /** 卡点解除后继续流程（修复成功 / 人工修好后的收尾） */
  proceed: (() => void) | null
  /** 当前 LLM 调用的中止器（20 分钟看门狗用） */
  abort?: AbortController | null
  /** 20 分钟看门狗定时器 */
  watchdog?: ReturnType<typeof setTimeout> | null
  /** 看门狗布防的阶段（超时时停掉/拆分用） */
  watchdogStageId?: string
  /** 本轮是否已用过拆分（拆分后再超时 → 上报问题卡片，不再二次拆分） */
  splitUsed?: boolean
  /** 看门狗主动中止的那个中止器（catch 里对比身份识别"本次调用是否被看门狗接管"，不能用布尔——拆分接管后旧调用的 catch 才落地，布尔已被新流程重置） */
  watchdogAborted?: AbortController | null
  /** 拆分完成后接力的 检查/修复/收尾 阶段 id；before = 接力前先补打勾的阶段（如编辑流的「构建」） */
  checkIds?: { check: string; repair: string | null; finish: string; before?: string[] }
}

interface Runtime {
  s: SessionData
  /** 是否有 Run 正在推进（LLM 调用中 / 阶段进行中） */
  running: boolean
  /** 生成中排队的用户消息 */
  queue: Array<{ text: string; attachments: string[]; messageId: string }>
  activeRun: ActiveRun | null
  autoTimer: ReturnType<typeof setTimeout> | null
  timers: Set<ReturnType<typeof setTimeout>>
}

const sessions = new Map<string, Runtime>()

/** 模板库根目录（boot 时同步；null = 无模板库，匹配环节降级为全自定义） */
let templatesRoot: string | null = null

/* ============================== 小工具 ============================== */

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function after(rt: Runtime, ms: number, fn: () => void): void {
  const t = setTimeout(() => {
    rt.timers.delete(t)
    fn()
  }, ms)
  rt.timers.add(t)
}

function truncate(text: string, max = 14): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 按需求关键词挑封面（演示期用示例封面图） */
function coverFor(text: string): string {
  if (/k8s|K8s|K8S|容器|集群|服务器|监控|运维/.test(text)) return '/covers/dash-k8s.png'
  if (/销售|营收|订单|业绩|门店|日报/.test(text)) return '/covers/dash-sales.png'
  if (/物流|车辆|运输|快递|仓储/.test(text)) return '/covers/dash-logistics.png'
  if (/能耗|用电|电力|能源|碳/.test(text)) return '/covers/dash-energy.png'
  return '/covers/dash-retail.png'
}

/* ============================== 事件发射（全部走 store.emit + 落盘） ============================== */

function save(rt: Runtime): void {
  store.saveSession(rt.s.dashboard.id, rt.s)
}

function setStatus(rt: Runtime, status: RunStatus): void {
  rt.s.runStatus = status
  store.emit(rt.s.dashboard.id, 'runStatus', { dashboardId: rt.s.dashboard.id, status })
  save(rt)
}

function pushMessage(rt: Runtime, m: ChatMessage): void {
  rt.s.messages.push(m)
  store.emit(rt.s.dashboard.id, 'message', { dashboardId: rt.s.dashboard.id, message: m })
  save(rt)
}

function updateMessage(rt: Runtime, m: ChatMessage): void {
  store.emit(rt.s.dashboard.id, 'messageUpdated', { dashboardId: rt.s.dashboard.id, message: m })
  save(rt)
}

function setStage(rt: Runtime, stage: Stage): void {
  const i = rt.s.stages.findIndex((x) => x.id === stage.id)
  if (i >= 0) rt.s.stages[i] = stage
  else rt.s.stages.push(stage)
  store.emit(rt.s.dashboard.id, 'stage', { dashboardId: rt.s.dashboard.id, stage })
  save(rt)
}

function setIssue(rt: Runtime, issue: Issue): void {
  const i = rt.s.issues.findIndex((x) => x.id === issue.id)
  if (i >= 0) rt.s.issues[i] = issue
  else rt.s.issues.push(issue)
  store.emit(rt.s.dashboard.id, 'issue', { dashboardId: rt.s.dashboard.id, issue })
  save(rt)
}

function setBlocker(rt: Runtime, blocker: Blocker | null): void {
  rt.s.blocker = blocker
  store.emit(rt.s.dashboard.id, 'blocker', { dashboardId: rt.s.dashboard.id, blocker })
  save(rt)
}

function addVersion(rt: Runtime, v: Version, url: string): void {
  rt.s.versions.forEach((x) => (x.isCurrent = false))
  rt.s.versions.unshift(v)
  rt.s.versionUrls[v.id] = url
  rt.s.dashboard.currentVersionLabel = v.label
  store.emit(rt.s.dashboard.id, 'versionAdded', { dashboardId: rt.s.dashboard.id, version: v })
  save(rt)
}

function upsertVersion(rt: Runtime, v: Version): void {
  const i = rt.s.versions.findIndex((x) => x.id === v.id)
  if (i >= 0) rt.s.versions[i] = v
  else rt.s.versions.unshift(v)
  store.emit(rt.s.dashboard.id, 'versionAdded', { dashboardId: rt.s.dashboard.id, version: v })
  save(rt)
}

function previewReady(rt: Runtime, versionId: string, url: string): void {
  rt.s.preview = { state: 'ready', url }
  store.emit(rt.s.dashboard.id, 'previewReady', { dashboardId: rt.s.dashboard.id, versionId, url })
  save(rt)
}

function updateDashboard(rt: Runtime, patch: Partial<Dashboard>): void {
  Object.assign(rt.s.dashboard, patch)
  rt.s.dashboard.updatedAt = Date.now()
  store.emit(rt.s.dashboard.id, 'dashboardUpdated', { dashboard: { ...rt.s.dashboard } })
  save(rt)
  persistDashboards()
}

function setAssist(rt: Runtime, session: AssistSession | null): void {
  rt.s.assistSession = session
  store.emit(rt.s.dashboard.id, 'assist', { dashboardId: rt.s.dashboard.id, session })
  save(rt)
}

function pushAgent(rt: Runtime, text: string): void {
  pushMessage(rt, { kind: 'agent', id: nextId('m'), createdAt: Date.now(), text })
}

function pushSystem(rt: Runtime, text: string): void {
  pushMessage(rt, { kind: 'system', id: nextId('m'), createdAt: Date.now(), text })
}

/* ============================== 推荐规则表（C12，确定性，与 mock 一致） ============================== */

type ProblemScenario = 'first_failure' | 'third_failure' | 'datasource_down' | 'high_risk'

interface ProblemContext {
  hasVersion: boolean
  lastVersionLabel: string | null
}

/**
 * 推荐规则表（UX §4.3，逐条对齐 mock scripts.ts 的 buildProblemOptions）：
 *   首次失败        → ★ 让 AI 再试一次（"同类问题自动修复成功率 90%+"，10 秒倒计时自动执行）
 *   同问题失败 3 次 → ★ 呼叫人工协助（"继续自动尝试成功率低，人工最快"）
 *   数据源不可用    → ★ 重新选择数据源（"不解决数据源，重试无意义"）
 *   高风险          → ★ 呼叫人工 / 转交审批（"高风险不允许自动绕过"，永不自动执行）
 */
export function buildProblemOptions(scenario: ProblemScenario, info: ProblemContext, now: number): CardOption[] {
  const assist: CardOption = {
    id: 'opt-assist',
    title: '呼叫人工协助',
    consequence: '支持人员能看到全部过程，通常几分钟解决',
    recommended: false,
    recommendReason: null,
    riskLevel: 'medium',
    autoExecuteAt: null
  }
  const retry: CardOption = {
    id: 'opt-retry',
    title: '让 AI 再试一次',
    consequence: '大约需要 1 分钟，多数问题能自动修好',
    recommended: false,
    recommendReason: null,
    riskLevel: 'low',
    autoExecuteAt: null
  }
  const retryAlt: CardOption = {
    ...retry,
    id: 'opt-retry-alt',
    title: '让 AI 再试一次（换一种方式）',
    consequence: '大约需要 1～2 分钟，不保证成功'
  }
  const rollback: CardOption | null = info.hasVersion
    ? {
        id: 'opt-rollback',
        title: '回退到上一个正常版本',
        consequence: `恢复到 ${info.lastVersionLabel}，之后的修改会保留，随时可以回来`,
        recommended: false,
        recommendReason: null,
        riskLevel: 'high',
        autoExecuteAt: null
      }
    : null
  const compact = (arr: Array<CardOption | null>): CardOption[] =>
    arr.filter((o): o is CardOption => o !== null)

  switch (scenario) {
    case 'first_failure':
      return compact([
        { ...retry, recommended: true, recommendReason: '同类问题自动修复成功率 90%+', autoExecuteAt: now + 10_000 },
        assist,
        rollback
      ])
    case 'third_failure':
      return compact([
        { ...assist, recommended: true, recommendReason: '继续自动尝试成功率低，人工最快' },
        retryAlt,
        rollback
      ])
    case 'datasource_down':
      return compact([
        {
          id: 'opt-reselect-datasource',
          title: '重新选择数据源',
          consequence: '换用备用数据源后继续，大约 1 分钟',
          recommended: true,
          recommendReason: '不解决数据源，重试无意义',
          riskLevel: 'medium',
          autoExecuteAt: null
        },
        { ...assist, consequence: '支持人员帮你检查数据源配置' }
      ])
    case 'high_risk':
      return compact([
        { ...assist, recommended: true, recommendReason: '高风险不允许自动绕过', riskLevel: 'high' },
        {
          id: 'opt-submit-approval',
          title: '转交审批',
          consequence: '提交给管理员审批后再继续',
          recommended: false,
          recommendReason: null,
          riskLevel: 'high',
          autoExecuteAt: null
        }
      ])
  }
}

/** 大模型调用失败（连不上/超时/回答格式不对）专用选项：★重试 + 检查设置 + 呼叫人工 */
function buildLlmFailureOptions(now: number): CardOption[] {
  return [
    {
      id: 'opt-retry-llm',
      title: '让 AI 再试一次',
      consequence: '重新连一次 AI，通常几秒到一分钟，多数能成功',
      recommended: true,
      recommendReason: '多数是网络波动，再试一次通常能成功',
      riskLevel: 'low',
      autoExecuteAt: now + 10_000
    },
    {
      id: 'opt-check-settings',
      title: '检查模型设置',
      consequence: '去设置里看看地址和 Key 有没有填错，改好后可以再试',
      recommended: false,
      recommendReason: null,
      riskLevel: 'low',
      autoExecuteAt: null
    },
    {
      id: 'opt-assist',
      title: '呼叫人工协助',
      consequence: '支持人员能看到全部过程，通常几分钟解决',
      recommended: false,
      recommendReason: null,
      riskLevel: 'medium',
      autoExecuteAt: null
    }
  ]
}

/* ============================== 设置与能力画像 ============================== */

const DEFAULT_SETTINGS: ModelSettings = {
  provider: '公司内置',
  apiBase: '',
  apiKey: '',
  model: '',
  plannerModel: '',
  coderModel: '',
  visionModel: ''
}

let cachedSettings: ModelSettings = { ...DEFAULT_SETTINGS }

/** 能力画像缓存：设置内容变 → 重新探测（SYSTEM_DESIGN §3.3 声明 + 探测） */
let capabilityCache: { key: string; ok: boolean; supportsVision: boolean } | null = null
let capabilityPending: Promise<{ ok: boolean; supportsVision: boolean }> | null = null

export function getSettings(): ModelSettings {
  return { ...cachedSettings }
}

export function saveSettings(s: ModelSettings): void {
  cachedSettings = { ...s }
  store.saveSettings(cachedSettings)
  capabilityCache = null
}

/** 能力协商（§4.2）：任务启动时探测一次，结果缓存到下次设置变更 */
async function getCapability(): Promise<{ ok: boolean; supportsVision: boolean }> {
  const key = JSON.stringify(cachedSettings)
  if (capabilityCache && capabilityCache.key === key) return capabilityCache
  if (capabilityPending) return capabilityPending
  capabilityPending = gw
    .probe(cachedSettings)
    .then((r) => {
      const cap = { key, ok: r.ok, supportsVision: r.supportsVision }
      capabilityCache = cap
      capabilityPending = null
      return { ok: cap.ok, supportsVision: cap.supportsVision }
    })
    .catch(() => {
      capabilityPending = null
      return { ok: false, supportsVision: false }
    })
  return capabilityPending
}

/* ============================== 阶段时间线 ============================== */

const CREATE_TITLES = ['理解需求', '匹配模板', '编写页面', '视觉检查', '修复问题', '生成预览']
const CREATE_TITLES_WITH_IMAGE = ['分析参考图片', '匹配模板', '编写页面', '视觉检查', '修复问题', '生成预览']
const EDIT_TITLES = ['修改', '构建', '检查']

function emitPlan(rt: Runtime, titles: string[]): void {
  titles.forEach((t, i) => {
    setStage(rt, {
      id: `st-${i + 1}`,
      title: t,
      state: i === 0 ? 'active' : 'pending',
      startedAt: i === 0 ? Date.now() : null,
      finishedAt: null,
      detail: null
    })
  })
  // 新方案比上一轮短时，抹掉多出来的旧槽位（store 只有 upsert 没有删除）
  for (let i = titles.length + 1; i <= rt.s.stages.length; i++) {
    const old = rt.s.stages.find((x) => x.id === `st-${i}`)
    if (old) setStage(rt, { ...old, title: '', state: 'done', startedAt: null, finishedAt: null, detail: null })
  }
}

function activateStage(rt: Runtime, id: string): void {
  const st = rt.s.stages.find((x) => x.id === id)
  if (!st || !st.title) return
  setStage(rt, { ...st, state: 'active', startedAt: Date.now(), finishedAt: null, detail: null })
}

function finishStage(rt: Runtime, id: string): void {
  const st = rt.s.stages.find((x) => x.id === id)
  if (!st || !st.title) return
  setStage(rt, { ...st, state: 'done', finishedAt: Date.now(), detail: null })
}

/** 更新进行中阶段的实时进展（客户端在时间线节点下滚动显示） */
function setStageDetail(rt: Runtime, id: string, detail: string | null): void {
  const st = rt.s.stages.find((x) => x.id === id)
  if (!st || !st.title || st.state !== 'active') return
  setStage(rt, { ...st, detail })
}

/**
 * LLM 流式进度 → 阶段详情行（节流 600ms；超过 90 秒附加安抚文案，杜绝"静默转圈"）。
 * label 例："正在编写页面"、"正在修复问题"。
 */
function llmProgress(rt: Runtime, stageId: string, label: string): (chars: number) => void {
  let lastPush = 0
  setStageDetail(rt, stageId, `${label}…正在等大模型开口`)
  return (chars) => {
    const now = Date.now()
    if (now - lastPush < 600) return
    lastPush = now
    const started = rt.s.stages.find((s) => s.id === stageId)?.startedAt ?? now
    const slowHint = now - started > 90_000 ? '，内容比较多，正在努力写' : ''
    setStageDetail(rt, stageId, `${label}…已生成 ${chars.toLocaleString('zh-CN')} 字${slowHint}`)
  }
}

/**
 * 首次创建时的"实时预览"：Coder 流式生成的部分 HTML 每 ~3 秒写一次 building 预览页
 * 并推 previewBuilding 事件，客户端预览区跟着逐步渲染，不再等全部写完才显示。
 */
function makeLivePreview(rt: Runtime): (partial: string) => void {
  let last = 0
  let n = 0
  return (partial) => {
    const now = Date.now()
    if (now - last < 3000) return
    if (partial.length < 1200 || !/<html[\s>]/i.test(partial)) return
    last = now
    n += 1
    const dashId = rt.s.dashboard.id
    store.writePreview(dashId, 'building', partial)
    const url = `/preview/${dashId}/building/index.html?t=${n}`
    rt.s.preview = { state: 'building', url }
    store.emit(dashId, 'previewBuilding', { dashboardId: dashId, url })
    save(rt)
  }
}

/* ============================== 20 分钟执行上限：看门狗 + 拆分步骤 ============================== */

/**
 * 单 Agent 单步执行上限（默认 20 分钟，冒烟可用 AGENT_STEP_MAX_MS 压小）。
 * 到点仍未完成：中止当前 LLM 调用 → 编码类任务自动拆成小步骤重做；其他任务上报问题卡片。
 */
const AGENT_STEP_MAX_MS = Number(process.env.AGENT_STEP_MAX_MS ?? 20 * 60 * 1000)

/**
 * 给当前 Agent 步骤布防看门狗，返回本次布防的令牌。
 * 调用方须持有本地 AbortController：catch 用 `run.watchdogAborted === ctl` 判断本次调用是否被看门狗接管，
 * finally 用令牌撤防（仅当看门狗还是本次的）——看门狗接管后会立刻布防新步骤，旧调用的收尾不许踩新步骤。
 */
function armAgentWatchdog(
  rt: Runtime,
  run: ActiveRun,
  stageId: string,
  kind: 'coding' | 'other',
  checkIds?: { check: string; repair: string | null; finish: string; before?: string[] }
): ReturnType<typeof setTimeout> {
  disarmAgentWatchdog(rt, run)
  run.watchdogStageId = stageId
  if (checkIds) run.checkIds = checkIds
  const t = setTimeout(() => {
    rt.timers.delete(t)
    if (run.watchdog !== t) return // 已被撤防/替换（防御性，正常到不了这里）
    run.watchdog = null
    const ctl = run.abort
    run.watchdogAborted = ctl ?? null
    ctl?.abort()
    if (kind === 'coding' && !run.splitUsed) {
      pushAgent(rt, '这一步做了超过 20 分钟还没做完，我把它拆成几步小的来做，会快很多。')
      void splitCodingFlow(rt, run, stageId)
      return
    }
    raiseOvertimeCard(rt, run, stageId, kind === 'coding')
  }, AGENT_STEP_MAX_MS)
  rt.timers.add(t)
  run.watchdog = t
  return t
}

/** 撤防看门狗；带令牌时仅当当前布防的还是那一次才撤（防止旧调用的 finally 撤掉新步骤的看门狗） */
function disarmAgentWatchdog(rt: Runtime, run: ActiveRun, token?: ReturnType<typeof setTimeout>): void {
  if (token !== undefined && run.watchdog !== token) return
  if (run.watchdog) {
    rt.timers.delete(run.watchdog)
    clearTimeout(run.watchdog)
    run.watchdog = null
  }
}

/**
 * 超时问题卡片。canSplit=true（编码步骤）→ ★把任务拆小重新做；
 * canSplit=false（规划/匹配/修复等非编码步骤）→ ★让 AI 再试一次（接 run.retryLlm，调用方须提前摆好）。
 * 另给 呼叫人工 / 回退（有版本时）。
 */
function raiseOvertimeCard(rt: Runtime, run: ActiveRun, stageId: string | null, canSplit: boolean): void {
  const title = '这一步做了太久'
  const description = canSplit
    ? '已经超过 20 分钟了还没做完。你的进度都还在，拆小一点重新做通常很快就出来。'
    : '已经超过 20 分钟了还没做完。你的进度都还在，重新做一次通常很快就出来。'
  const options: CardOption[] = [
    canSplit
      ? {
          id: 'opt-split-redo',
          title: '把任务拆小重新做',
          consequence: '分成几步小任务，每一步都很快，大约 2～3 分钟',
          recommended: true,
          recommendReason: '拆开做每一步都在 20 分钟内，成功率最高',
          riskLevel: 'low',
          autoExecuteAt: null
        }
      : {
          id: 'opt-retry-llm',
          title: '让 AI 再试一次',
          consequence: '重新做一次这一步，之前的进度都还在',
          recommended: true,
          recommendReason: '多数是模型一时卡住，重新做一次通常能成',
          riskLevel: 'low',
          autoExecuteAt: null
        },
    {
      id: 'opt-assist',
      title: '呼叫人工协助',
      consequence: '支持人员能看到全部过程，通常几分钟解决',
      recommended: false,
      recommendReason: null,
      riskLevel: 'medium',
      autoExecuteAt: null
    }
  ]
  if (rt.s.versions.length > 0) {
    options.push({
      id: 'opt-rollback',
      title: '回退到上一个正常版本',
      consequence: '恢复到最近的可用版本，之后的修改会保留，随时可以回来',
      recommended: false,
      recommendReason: null,
      riskLevel: 'high',
      autoExecuteAt: null
    })
  }
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: Date.now(),
    title,
    description,
    options,
    chosenOptionId: null,
    relatedIssueId: null
  }
  pushMessage(rt, msg)
  setBlocker(rt, { id: nextId('blk'), type: 'failed', title, description, options, relatedMessageId: msg.id })
  setStatus(rt, 'blocked')
  updateDashboard(rt, { status: 'needs_attention' })
  run.pending.awaiting = 'problem'
  if (stageId) finishStageQuiet(rt, stageId)
  rt.running = false
  save(rt)
}

/**
 * 拆分步骤（编码任务超时的标准拆解）：
 *   第 1 步：只生成页面骨架（完整 HTML 结构 + 全部样式 + 每个面板一个 <!--PANEL:名称--> 占位注释）
 *   第 2..N 步：逐个面板生成内容片段，填回占位注释
 * 每一步都是独立的小 LLM 调用（各自布防看门狗），单次不会超过 20 分钟。
 */
async function splitCodingFlow(rt: Runtime, run: ActiveRun, stageId: string): Promise<void> {
  rt.running = true
  run.splitUsed = true
  run.pending.awaiting = null
  // 子步骤超时（看门狗超时卡片）的"让 AI 再试一次"= 重跑整个拆分
  run.retryLlm = () => void splitCodingFlow(rt, run, stageId)
  setStatus(rt, 'generating')
  setBlocker(rt, null)
  activateStage(rt, stageId)
  const livePreview = rt.s.versions.length === 0 ? makeLivePreview(rt) : null
  const ids = run.checkIds ?? { check: 'st-4', repair: 'st-5', finish: 'st-6' }
  /** 接力检查前，把正常路径会走、拆分路径跳过的阶段补打勾（如编辑流的「构建」st-2） */
  const finishBeforeStages = (): void => {
    for (const id of ids.before ?? []) {
      activateStage(rt, id)
      finishStage(rt, id)
    }
  }

  const requirement =
    run.pending.kind === 'create'
      ? `请做这样一个大屏：${run.pending.text}${run.pending.answersSummary ? `\n用户确认的偏好：${run.pending.answersSummary}` : ''}`
      : editRequirement(rt, run)

  /**
   * 每个子步骤一次独立 LLM 调用（带看门狗和中止器）。
   * 返回 null = 本次调用被看门狗中止（超时卡片已接管），调用方直接 return，不再报失败卡。
   * 注意：绝不重置 run.watchdogAborted——被中止的旧调用 catch 可能比新流程晚落地，要靠它认出"自己被接管了"。
   */
  async function callStep(label: string, userContent: string, onPartial?: (partial: string) => void): Promise<string | null> {
    const wd = armAgentWatchdog(rt, run, stageId, 'other')
    const ctl = new AbortController()
    run.abort = ctl
    const progress = llmProgress(rt, stageId, label)
    try {
      return await gw.chatCompletionStream(
        cachedSettings,
        {
          role: 'coder',
          messages: [
            { role: 'system', content: prompt('coder.system') },
            { role: 'user', content: userContent }
          ],
          signal: ctl.signal
        },
        (chars, partial) => {
          progress(chars)
          onPartial?.(partial)
        }
      )
    } catch (err) {
      if (run.watchdogAborted === ctl) return null
      throw err
    } finally {
      if (run.abort === ctl) run.abort = null
      disarmAgentWatchdog(rt, run, wd)
    }
  }

  try {
    // 第 1 步：骨架
    const skeletonRaw = await callStep(
      '拆分步骤 1：先搭页面骨架',
      prompt('split.skeleton.user', { requirement }),
      (partial) => livePreview?.(partial)
    )
    if (skeletonRaw === null) return // 看门狗已接管
    let html = gw.extractHtml(skeletonRaw)
    // 记录占位注释原文：名字 trim 后拼正则可能匹配不到含空格的原始注释，替换一律用原文
    const panels = [...html.matchAll(/<!--PANEL:([^>]+?)-->/g)]
      .map((m) => ({ raw: m[0], name: (m[1] ?? '').trim() }))
      .filter((p) => p.name.length > 0)
      .slice(0, 6)

    if (panels.length === 0) {
      // 模型没按占位约定输出：骨架已是完整页面，直接进入检查
      run.html = html
      finishStage(rt, stageId)
      finishBeforeStages()
      await checkRepairAndFinish(rt, run, ids.check, ids.repair, ids.finish)
      return
    }

    // 第 2..N 步：逐个面板生成内容
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]
      try {
        const fragment = await callStep(
          `拆分步骤 ${i + 2}/${panels.length + 1}：生成「${truncate(p.name, 10)}」`,
          prompt('split.panel.user', { requirement, panelName: p.name })
        )
        if (fragment === null) return // 看门狗已接管
        html = html.replace(p.raw, () => fragment)
        livePreview?.(html)
      } catch (err) {
        // 单个面板失败：留占位说明，交给后续视觉检查 + 修复兜底
        html = html.replace(p.raw, () => `<!-- 「${p.name}」暂未生成 -->`)
      }
    }

    // 兜底：成品里不允许残留面板占位注释（异常路径防御，正常循环后不应剩余）
    if (/<!--PANEL:/.test(html)) {
      console.warn(`[orchestrator] ${rt.s.dashboard.id} 拆分生成后仍有面板占位符残留，已清理`)
      html = html.replace(/<!--PANEL:[^>]*?-->/g, '<!-- 面板暂未生成 -->')
    }

    run.html = html
    pushAgent(rt, '拆分生成完成，各部分已经拼好了。')
    finishStage(rt, stageId)
    finishBeforeStages()
    await checkRepairAndFinish(rt, run, ids.check, ids.repair, ids.finish)
  } catch (err) {
    raiseLlmFailureCard(rt, run, err, stageId)
    rt.running = false
  }
}

/** 编辑拆分的任务描述：带上当前大屏完整 HTML，在保持现有内容的基础上改（丢了就会把原页面静默替换掉） */
function editRequirement(rt: Runtime, run: ActiveRun): string {
  const instruction = run.pending.text || '按用户发的参考图调整'
  const current = rt.s.versions.find((v) => v.isCurrent) ?? rt.s.versions[0]
  const currentHtml = run.html || (current ? (store.readPreview(rt.s.dashboard.id, current.id) ?? '') : '')
  if (!currentHtml) return `用户要把现有大屏改成：${instruction}`
  return `这是当前大屏的完整 HTML：\n${currentHtml}\n\n用户要求修改：${instruction}\n\n请在保持现有页面整体结构和内容不变的基础上完成这个修改。接下来会分步进行，请配合每一步的输出要求。`
}

/* ============================== LLM：Planner ============================== */

interface PlanResult {
  analysis: string
  needClarification: boolean
  intro: string
  questions: ClarificationQuestion[]
}

/** 规划输出规范化：≤3 题、每题 2~3 选项、恰一个 ★推荐（不符合就确定性修正） */
function normalizePlan(raw: unknown): PlanResult {
  const obj = (raw ?? {}) as Record<string, unknown>
  const analysis = typeof obj.analysis === 'string' && obj.analysis.trim() ? obj.analysis.trim() : '好的，我明白你的需求了。'
  const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : '开始之前，想跟你确认几件事'
  const questions: ClarificationQuestion[] = []
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : []
  for (const [qi, rq] of rawQuestions.slice(0, 3).entries()) {
    const q = (rq ?? {}) as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question.trim()) continue
    const rawOpts = Array.isArray(q.options) ? q.options : []
    const options: CardOption[] = []
    for (const [oi, ro] of rawOpts.slice(0, 3).entries()) {
      const o = (ro ?? {}) as Record<string, unknown>
      if (typeof o.title !== 'string' || !o.title.trim()) continue
      options.push({
        id: `q${qi + 1}-opt${oi + 1}`,
        title: o.title.trim(),
        consequence:
          typeof o.consequence === 'string' && o.consequence.trim() ? o.consequence.trim() : '按这个选择继续做',
        recommended: o.recommended === true,
        recommendReason:
          typeof o.recommendReason === 'string' && o.recommendReason.trim() ? o.recommendReason.trim() : null,
        riskLevel: 'low',
        autoExecuteAt: null
      })
    }
    if (options.length < 2) continue // 少于 2 个选项的问题没有确认价值，丢掉
    // 恰一个 ★推荐：没有就标第一个，多了只留第一个
    let firstRec = options.findIndex((o) => o.recommended)
    if (firstRec < 0) firstRec = 0
    options.forEach((o, i) => {
      if (i !== firstRec) {
        o.recommended = false
        o.recommendReason = null
      } else {
        o.recommended = true
        if (!o.recommendReason) o.recommendReason = '这个选择最稳妥，一次通过率最高'
      }
    })
    questions.push({
      id: `q${qi + 1}`,
      question: q.question.trim(),
      options,
      allowCustomInput: true,
      answer: null
    })
  }
  return {
    analysis,
    needClarification: obj.needClarification === true && questions.length > 0,
    intro,
    questions
  }
}

/** 组装 planner 的用户消息（vision 可用才带图，否则走非多模态路径并提示） */
function plannerUserContent(text: string, attachments: string[], vision: boolean): gw.LlmMessage['content'] {
  const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
  const body = prompt('planner.user', {
    text: text || '（用户只发了图片，没有文字）',
    noVisionNote: attachments.length > 0 && !vision ? prompt('planner.user.no-vision-note') : ''
  })
  parts.push({ type: 'text', text: body })
  if (vision) {
    for (const url of attachments) parts.push({ type: 'image_url', image_url: { url } })
  }
  return parts
}

async function callPlanner(
  text: string,
  attachments: string[],
  vision: boolean,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<PlanResult> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'planner',
    messages: [
      { role: 'system', content: prompt('planner.system') },
      { role: 'user', content: plannerUserContent(text, attachments, vision) }
    ],
    signal
  }, onProgress ?? (() => {}))
  return normalizePlan(gw.extractJson(reply))
}

/* ============================== LLM：Coder ============================== */

async function callCoderCreate(
  text: string,
  answersSummary: string,
  template: TemplateDecision | null | undefined,
  vision: boolean,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const tpl = template ? templateContext(template, vision) : { text: '', images: [] }
  const userText = prompt('coder.create.user', {
    text,
    answersBlock: answersSummary ? prompt('coder.create.answers-block', { answersSummary }) : '',
    templateContext: tpl.text,
    imageNote: tpl.images.length > 0 ? prompt('coder.create.image-note') : ''
  })
  const content: LlmUserContent =
    tpl.images.length > 0
      ? [{ type: 'text', text: userText }, ...tpl.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
      : userText
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'coder',
    messages: [
      { role: 'system', content: prompt('coder.system') },
      { role: 'user', content }
    ],
    signal
  }, onProgress ?? (() => {}))
  return gw.extractHtml(reply)
}

async function callCoderEdit(currentHtml: string, instruction: string, onProgress?: (chars: number, partial: string) => void, signal?: AbortSignal): Promise<string> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'coder',
    messages: [
      { role: 'system', content: prompt('coder.system') },
      {
        role: 'user',
        content: prompt('coder.edit.user', { currentHtml, instruction })
      }
    ],
    signal
  }, onProgress ?? (() => {}))
  return gw.extractHtml(reply)
}

async function callCoderRepair(html: string, problems: string[], onProgress?: (chars: number, partial: string) => void, signal?: AbortSignal): Promise<string> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'coder',
    messages: [
      { role: 'system', content: prompt('coder.system') },
      {
        role: 'user',
        content: prompt('coder.repair.user', { problems: problems.map((p) => `- ${p}`).join('\n'), html })
      }
    ],
    signal
  }, onProgress ?? (() => {}))
  return gw.extractHtml(reply)
}

/** 多模态 user content（与 gateway.LlmMessage['content'] 对齐） */
type LlmUserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

/* ============================== LLM：模板匹配 ============================== */

interface MatchResult {
  layoutId: string | null
  layoutReason: string
  componentIds: string[]
  unmatched: string[]
}

async function callTemplateMatch(
  text: string,
  attachments: string[],
  vision: boolean,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<MatchResult> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    {
      type: 'text',
      text: prompt('match.user', {
        text,
        catalog: catalogText(),
        keywordHint: keywordHint(text),
        modeNote: vision ? prompt('match.note-vision') : prompt('match.note-text')
      })
    }
  ]
  if (vision) {
    for (const url of attachments.slice(0, 1)) content.push({ type: 'image_url', image_url: { url } })
    if (templatesRoot) {
      for (const l of LAYOUTS) {
        const dataUrl = templateImageDataUrl(templatesRoot, l.image.replace(/^\//, ''))
        if (dataUrl) content.push({ type: 'image_url', image_url: { url: dataUrl } })
      }
    }
  }
  const reply = await gw.chatCompletionStream(
    cachedSettings,
    { role: 'planner', messages: [{ role: 'system', content: prompt('match.system') }, { role: 'user', content }], signal },
    onProgress ?? (() => {})
  )
  const parsed = gw.extractJson(reply) as Partial<MatchResult>
  const layoutId = LAYOUTS.some((l) => l.id === parsed.layoutId) ? (parsed.layoutId as string) : null
  return {
    layoutId,
    layoutReason: typeof parsed.layoutReason === 'string' ? parsed.layoutReason : '',
    componentIds: Array.isArray(parsed.componentIds)
      ? parsed.componentIds.filter((id): id is string => COMPONENTS.some((c) => c.id === id))
      : [],
    unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched.map(String).filter(Boolean) : []
  }
}

/** 模板上下文：注入 Coder prompt 的结构约束文本 + 参考图（vision 时） */
function templateContext(dec: TemplateDecision, vision: boolean): { text: string; images: string[] } {
  if (!dec.useTemplate) return { text: '', images: [] }
  const layout = LAYOUTS.find((l) => l.id === dec.layoutId)
  const comps = COMPONENTS.filter((c) => dec.componentIds.includes(c.id))
  if (!layout && comps.length === 0) return { text: '', images: [] }
  const text = prompt('coder.template-context', {
    layoutBlock: layout
      ? prompt('coder.template-context.layout-block', { layoutName: layout.name, layoutStructure: layout.structure }) + '\n'
      : '',
    componentsBlock:
      comps.length > 0
        ? prompt('coder.template-context.components-block', {
            componentLines: comps.map((c) => `- ${c.name}：${c.description}`).join('\n')
          })
        : ''
  })
  const images: string[] = []
  if (vision && templatesRoot) {
    for (const rel of [layout?.image, ...comps.slice(0, 3).map((c) => c.image)]) {
      if (!rel) continue
      const dataUrl = templateImageDataUrl(templatesRoot, rel.replace(/^\//, ''))
      if (dataUrl) images.push(dataUrl)
    }
  }
  return { text, images }
}

/* ============================== LLM：视觉检查（结构化布局审查，设计 §4.1 非多模态路径） ============================== */

interface ReviewIssue {
  title: string
  detail: string
}

async function callVisualReview(html: string, requirement: string, onProgress?: (chars: number, partial: string) => void, signal?: AbortSignal): Promise<ReviewIssue[]> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'planner',
    messages: [
      { role: 'system', content: prompt('review.system') },
      { role: 'user', content: prompt('review.user', { requirement, html }) }
    ],
    signal
  }, onProgress ?? (() => {}))
  const parsed = gw.extractJson(reply) as { issues?: Array<{ title?: unknown; detail?: unknown }> }
  if (!Array.isArray(parsed.issues)) return []
  return parsed.issues
    .slice(0, 3)
    .map((i) => ({ title: String(i.title ?? '').trim(), detail: String(i.detail ?? '').trim() }))
    .filter((i) => i.title.length > 0)
}

/* ============================== 确定性校验（硬约束的落地） ============================== */

function validateHtml(html: string): string[] {
  const problems: string[] = []
  if (!/<html[\s>]/i.test(html)) problems.push('不是完整的网页（缺少 html 标签）')
  if (html.length < 2048) problems.push('内容太少，不像一个完整的大屏页面')
  if (/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html) || /url\(\s*["']?\s*https?:\/\//i.test(html))
    problems.push('引用了外部资源（大屏要求所有内容都写在一个文件里）')
  return problems
}

/** 确定性清洗（人工协助修好时用）：剥掉外部资源引用，保证校验能过 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/(<(?:script|link|img|iframe|source)[^>]*?\s)(?:src|href)\s*=\s*["']\s*https?:\/\/[^"']*["']/gi, '$1data-removed-external=""')
    .replace(/url\(\s*["']?\s*https?:\/\/[^)"']*["']?\s*\)/gi, 'url(about:blank)')
}

/* ============================== 卡点与问题卡片 ============================== */

function latestFailedIssue(rt: Runtime): Issue | null {
  const failed = rt.s.issues.filter((i) => i.status === 'failed')
  return failed.length > 0 ? failed[failed.length - 1] : null
}

function clearAutoExec(rt: Runtime): void {
  if (rt.autoTimer) {
    clearTimeout(rt.autoTimer)
    rt.autoTimer = null
  }
}

/** 倒计时自动执行（C11）：到点用户还没选，则自动 chooseOption */
function armAutoExec(rt: Runtime, options: CardOption[]): void {
  clearAutoExec(rt)
  const auto = options.find((o) => o.autoExecuteAt !== null)
  if (!auto) return
  const delay = Math.max(0, (auto.autoExecuteAt as number) - Date.now())
  rt.autoTimer = setTimeout(() => {
    rt.autoTimer = null
    handleChooseOption(rt.s.dashboard.id, auto.id, true)
  }, delay)
}

/** 校验修复超预算 → 问题处理卡片（推荐按规则表） */
function raiseFixProblemCard(rt: Runtime, run: ActiveRun, issue: Issue): void {
  const scenario: ProblemScenario = issue.attempt >= 3 ? 'third_failure' : 'first_failure'
  const options = buildProblemOptions(
    scenario,
    { hasVersion: rt.s.versions.length > 0, lastVersionLabel: rt.s.versions[0]?.label ?? null },
    Date.now()
  )
  const title = scenario === 'third_failure' ? '自动修复没有成功' : '检查时出了点小问题'
  const description =
    scenario === 'third_failure'
      ? `「${issue.title}」已经尝试了 ${issue.attempt} 次，仍没修好。`
      : `「${issue.title}」自动修复没有成功，这是第 ${issue.attempt} 次尝试。`
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: Date.now(),
    title,
    description,
    options,
    chosenOptionId: null,
    relatedIssueId: issue.id
  }
  pushMessage(rt, msg)
  setBlocker(rt, {
    id: nextId('blk'),
    type: scenario === 'first_failure' ? 'failed' : 'escalated',
    title,
    description,
    options,
    relatedMessageId: msg.id
  })
  setStatus(rt, 'blocked')
  updateDashboard(rt, { status: 'needs_attention' })
  run.pending.awaiting = 'problem'
  save(rt)
  armAutoExec(rt, options)
}

/** 大模型调用失败 → 问题处理卡片（★让 AI 再试一次 / 检查模型设置 / 呼叫人工），不许静默转圈 */
function raiseLlmFailureCard(rt: Runtime, run: ActiveRun, err: unknown, stageId: string | null): void {
  const e = err instanceof gw.GatewayError ? err : null
  const title = 'AI 暂时没有回应'
  const description = `${e ? e.message : 'AI 这次没有回应'}。你的进度都还在，可以再试一次。`
  const options = buildLlmFailureOptions(Date.now())
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: Date.now(),
    title,
    description,
    options,
    chosenOptionId: null,
    relatedIssueId: null
  }
  pushMessage(rt, msg)
  setBlocker(rt, {
    id: nextId('blk'),
    type: 'failed',
    title,
    description: e?.detail ? `${description}（详情：${e.detail.slice(0, 120)}）` : description,
    options,
    relatedMessageId: msg.id
  })
  setStatus(rt, 'blocked')
  updateDashboard(rt, { status: 'needs_attention' })
  run.pending.awaiting = 'llm'
  if (stageId) finishStageQuiet(rt, stageId)
  save(rt)
  armAutoExec(rt, options)
}

/** 模板完全没匹配上 → 确认卡片：★自定义生成 / 用最接近的模板（UX §4.3 规范） */
function raiseTemplateConfirmCard(rt: Runtime, run: ActiveRun, match: MatchResult | null): void {
  const title = '模板库里没有完全匹配的模板'
  const description = '你的需求和模板库里的布局、组件都对不上。可以让我按你的需求从零自定义，也可以先用最接近的模板搭个底子。'
  const options: CardOption[] = [
    {
      id: 'opt-custom-generate',
      title: '自定义生成组件',
      consequence: '我按你的描述从零设计，更贴合需求，但样式没有模板保底',
      recommended: true,
      recommendReason: '模板都对不上时，硬套模板反而四不像，自定义更贴合',
      riskLevel: 'low',
      autoExecuteAt: null
    },
    {
      id: 'opt-use-nearest',
      title: '用最接近的模板做',
      consequence: '用「U 型环绕」布局和通用图表样式搭底子，后续再慢慢调',
      recommended: false,
      recommendReason: null,
      riskLevel: 'low',
      autoExecuteAt: null
    }
  ]
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: Date.now(),
    title,
    description: match?.unmatched.length ? `${description}（对不上的部分：${match.unmatched.join('、')}）` : description,
    options,
    chosenOptionId: null,
    relatedIssueId: null
  }
  pushMessage(rt, msg)
  setBlocker(rt, {
    id: nextId('blk'),
    type: 'clarification',
    title: '需要你定一下做法',
    description: '模板库里没有完全匹配的模板，选一个做法我就继续。',
    options,
    relatedMessageId: msg.id
  })
  setStatus(rt, 'blocked')
  run.pending.awaiting = 'problem'
  // 自由输入兜底 = 按自定义继续
  run.retryLlm = () => {
    if (run.pending.template) run.pending.template.useTemplate = false
    void continueCreateToCoding(rt, run)
  }
  save(rt)
}

/** LLM 失败时把进行中的阶段停掉（不留永久转圈） */
function finishStageQuiet(rt: Runtime, id: string): void {
  const st = rt.s.stages.find((x) => x.id === id)
  if (st && st.state === 'active') setStage(rt, { ...st, state: 'pending', startedAt: null, finishedAt: null })
}

/* ============================== 主流程：新建 ============================== */

function newPending(kind: 'create' | 'edit', text: string, attachments: string[]): PendingRun {
  return {
    kind,
    text,
    attachments,
    answersSummary: '',
    awaiting: null,
    clarificationMessageId: null,
    failCount: 0,
    issueId: null
  }
}

async function runCreate(rt: Runtime, run: ActiveRun): Promise<void> {
  const dashId = rt.s.dashboard.id
  const hasImage = run.pending.attachments.length > 0
  rt.running = true
  rt.s.pendingRun = run.pending
  emitPlan(rt, hasImage ? CREATE_TITLES_WITH_IMAGE : CREATE_TITLES)
  setStatus(rt, 'generating')
  updateDashboard(rt, { status: 'generating' })

  // 能力协商（§4.2）：决定带不带图
  const cap = await getCapability()
  if (!cap.ok) {
    raiseLlmFailureCard(rt, run, new gw.GatewayError('连不上：地址似乎不对或 Key 无效', '能力探测未通过，请检查设置里的地址和 Key。'), 'st-1')
    run.retryLlm = () => void runCreate(rt, run)
    rt.running = false
    return
  }
  const vision = hasImage && cap.supportsVision

  pushAgent(
    rt,
    hasImage
      ? vision
        ? '好的，我先仔细看看你发来的图片…'
        : '好的，我来帮你做。你发了参考图片，但当前模型看不了图片，我会按你的文字描述来做。'
      : '好的，我来帮你做。先理解一下你的需求…'
  )

  // 阶段 1：理解需求 / 分析参考图片（Planner LLM，20 分钟看门狗）
  let plan: PlanResult
  run.retryLlm = () => void runCreate(rt, run) // 超时卡片的"让 AI 再试一次"也走这里
  const wdPlan = armAgentWatchdog(rt, run, 'st-1', 'other')
  const ctl = new AbortController()
  run.abort = ctl
  try {
    plan = await callPlanner(run.pending.text, run.pending.attachments, vision, llmProgress(rt, 'st-1', '正在分析需求'), ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（超时卡片）
    raiseLlmFailureCard(rt, run, err, 'st-1')
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdPlan)
  }
  finishStage(rt, 'st-1')
  pushAgent(rt, hasImage && vision ? `图片分析完了：${plan.analysis}` : `我理解了：${plan.analysis}`)

  // 需要澄清且还没答过：发澄清卡片，等待回答
  if (plan.needClarification && !run.pending.answersSummary) {
    const card: ClarificationMessage = {
      kind: 'clarification',
      id: nextId('m'),
      createdAt: Date.now(),
      intro: plan.intro,
      questions: plan.questions,
      answered: false
    }
    pushMessage(rt, card)
    setStatus(rt, 'awaiting_clarification')
    setBlocker(rt, {
      id: nextId('blk'),
      type: 'clarification',
      title: '需要你补充一点信息',
      description: '回答左边对话里的问题后，我就接着做。',
      options: [
        {
          id: 'opt-goto-answer',
          title: '去回答',
          consequence: '跳到对话里的问题卡片',
          recommended: true,
          recommendReason: '补充信息后一次通过率最高',
          riskLevel: 'low',
          autoExecuteAt: null
        }
      ],
      relatedMessageId: card.id
    })
    run.pending.awaiting = 'clarification'
    run.pending.clarificationMessageId = card.id
    save(rt)
    rt.running = false
    return
  }

  await continueCreateToCoding(rt, run)
}

/** 澄清之后（或无需澄清）：匹配模板 → 编写页面 → 视觉检查 → 修复问题 → 生成预览 */
async function continueCreateToCoding(rt: Runtime, run: ActiveRun): Promise<void> {
  rt.running = true
  setStatus(rt, 'generating')
  activateStage(rt, 'st-2')

  // 阶段 2：匹配模板（模板库存在且本轮还没匹配过时）
  if (templatesRoot && !run.pending.template) {
    setStageDetail(rt, 'st-2', `正在和模板库比对：${LAYOUTS.length} 种布局、${COMPONENTS.length} 类组件…`)
    let match: MatchResult | null = null
    run.retryLlm = () => void continueCreateToCoding(rt, run) // 超时卡片的"让 AI 再试一次"也走这里
    const cap = await getCapability()
    const vision = run.pending.attachments.length > 0 && cap.ok && cap.supportsVision
    const wdMatch = armAgentWatchdog(rt, run, 'st-2', 'other')
    const ctlMatch = new AbortController()
    run.abort = ctlMatch
    try {
      match = await callTemplateMatch(
        run.pending.text,
        run.pending.attachments,
        vision,
        llmProgress(rt, 'st-2', '正在比对模板'),
        ctlMatch.signal
      )
    } catch (err) {
      if (run.watchdogAborted === ctlMatch) return // 看门狗已接管（超时卡片），不能再按"没匹配上"发卡
      match = null // 匹配失败不阻塞：按全自定义继续
    } finally {
      if (run.abort === ctlMatch) run.abort = null
      disarmAgentWatchdog(rt, run, wdMatch)
    }

    if (match && (match.layoutId !== null || match.componentIds.length > 0)) {
      // 有命中（含部分命中）：继续，未覆盖部分自定义
      run.pending.template = {
        layoutId: match.layoutId ?? 'layoutU',
        componentIds: match.componentIds,
        useTemplate: true
      }
      const layoutName = LAYOUTS.find((l) => l.id === run.pending.template?.layoutId)?.name
      const compNames = match.componentIds
        .map((id) => COMPONENTS.find((c) => c.id === id)?.name)
        .filter(Boolean)
        .join('、')
      pushAgent(
        rt,
        `模板匹配好了：布局用「${layoutName}」${compNames ? `，组件匹配到 ${compNames}` : ''}，这些都会照着模板库的标准样式来做，还原度更高。` +
          (match.unmatched.length > 0 ? `另外「${match.unmatched.join('、')}」模板库里没有，这部分我按需求自定义。` : '')
      )
      finishStage(rt, 'st-2')
    } else {
      // 完全没匹配上：让用户确认是否自定义生成（UX：必选项 + 必推荐）
      run.pending.template = { layoutId: null, componentIds: [], useTemplate: false }
      finishStage(rt, 'st-2')
      raiseTemplateConfirmCard(rt, run, match)
      rt.running = false
      return
    }
  } else {
    // 无模板库（或用户已做过选择）：直接过
    if (!run.pending.template) setStageDetail(rt, 'st-2', '按需求挑选合适的图表和布局结构…')
    await sleep(600)
    finishStage(rt, 'st-2')
  }

  activateStage(rt, 'st-3')
  // 首次创建（没有任何旧版本）时：边生成边把部分 HTML 推到预览区，页面逐步长出来
  const livePreview = rt.s.versions.length === 0 ? makeLivePreview(rt) : null
  const progress = llmProgress(rt, 'st-3', '正在编写页面')
  const capForVision = await getCapability()
  const visionOk = capForVision.ok && capForVision.supportsVision
  let html: string
  const wdCode = armAgentWatchdog(rt, run, 'st-3', 'coding', { check: 'st-4', repair: 'st-5', finish: 'st-6' })
  const ctl = new AbortController()
  run.abort = ctl
  try {
    html = await callCoderCreate(run.pending.text, run.pending.answersSummary, run.pending.template, visionOk, (chars, partial) => {
      progress(chars)
      livePreview?.(partial)
    }, ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（自动拆分步骤）
    raiseLlmFailureCard(rt, run, err, 'st-3')
    run.retryLlm = () => void continueCreateToCoding(rt, run)
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdCode)
  }
  run.html = html
  finishStage(rt, 'st-3')

  await checkRepairAndFinish(rt, run, 'st-4', 'st-5', 'st-6')
}

/** 视觉检查 + 修复循环 + 收尾提交（新建：检查 st-4 → 修复 st-5 → 生成预览 st-6；修改：检查 st-3 内合并，repairStageId 传 null） */
async function checkRepairAndFinish(
  rt: Runtime,
  run: ActiveRun,
  checkStageId: string,
  repairStageId: string | null,
  finishStageId: string
): Promise<void> {
  activateStage(rt, checkStageId)
  const fixStageId = repairStageId ?? checkStageId

  // 视觉检查 = 确定性硬校验 + LLM 结构化布局审查（审查失败不阻塞，硬校验兜底；LLM 调用布防看门狗，卡死出超时卡片）
  setStageDetail(rt, checkStageId, '先做硬性规则检查：页面完整性、是否引用外部素材…')
  let hard = validateHtml(run.html)
  let review: ReviewIssue[] = []
  run.retryLlm = () => void checkRepairAndFinish(rt, run, checkStageId, repairStageId, finishStageId)
  const wdReview = armAgentWatchdog(rt, run, checkStageId, 'other')
  const ctlReview = new AbortController()
  run.abort = ctlReview
  try {
    review = await callVisualReview(run.html, run.pending.text, llmProgress(rt, checkStageId, '正在审查布局'), ctlReview.signal)
  } catch (err) {
    if (run.watchdogAborted === ctlReview) return // 看门狗已接管（超时卡片）
    review = []
  } finally {
    if (run.abort === ctlReview) run.abort = null
    disarmAgentWatchdog(rt, run, wdReview)
  }
  let problems = [...hard, ...review.map((r) => r.title)]
  const details = new Map(review.map((r) => [r.title, r.detail]))
  finishStage(rt, checkStageId)

  if (problems.length === 0) {
    pushAgent(rt, '检查完成，没有发现大问题。')
    if (repairStageId) finishStage(rt, repairStageId) // 无需修复，直接打勾
    await finishRunCommit(rt, run, finishStageId)
    return
  }

  // 有问题 → 修复问题阶段：每个问题一张 Issue 卡（最多 3 张），≤2 次自动修复
  if (repairStageId) activateStage(rt, repairStageId)
  const issues: Issue[] = problems.slice(0, 3).map((p, i) => ({
    id: i === 0 ? (run.pending.issueId ?? nextId('issue')) : nextId('issue'),
    stageId: fixStageId,
    title: p,
    attempt: 1,
    status: 'fixing' as const,
    beforeShotUrl: rt.s.dashboard.coverUrl || null,
    afterShotUrl: null,
    detail: details.get(p) ?? ''
  }))
  run.pending.issueId = issues[0].id
  pushAgent(rt, `检查发现 ${issues.length} 个小问题，正在挨个自动修复…`)
  issues.forEach((i) => setIssue(rt, { ...i }))

  let firstPass = true
  while (problems.length > 0) {
    issues.forEach((i) => {
      if (!firstPass) i.attempt += 1
      i.status = 'fixing'
      setIssue(rt, { ...i })
    })
    firstPass = false
    run.pending.failCount += 1
    run.retryLlm = () => void resumeRepair(rt, run, fixStageId, finishStageId)
    const wdFix = armAgentWatchdog(rt, run, fixStageId, 'other')
    const ctlFix = new AbortController()
    run.abort = ctlFix
    try {
      run.html = await callCoderRepair(run.html, problems, llmProgress(rt, fixStageId, '正在修复问题'), ctlFix.signal)
    } catch (err) {
      if (run.watchdogAborted === ctlFix) return // 看门狗已接管（超时卡片）
      issues.forEach((i) => setIssue(rt, { ...i, status: 'failed' }))
      raiseLlmFailureCard(rt, run, err, fixStageId)
      rt.running = false
      return
    } finally {
      if (run.abort === ctlFix) run.abort = null
      disarmAgentWatchdog(rt, run, wdFix)
    }
    // 修复后复跑硬校验（结构化审查的结论无法程序复核，硬校验通过即视为修好）
    hard = validateHtml(run.html)
    if (hard.length === 0) {
      issues.forEach((i) =>
        setIssue(rt, {
          ...i,
          status: 'fixed',
          afterShotUrl: rt.s.dashboard.coverUrl || null,
          detail: 'AI 已重新生成并通过检查。'
        })
      )
      finishStage(rt, fixStageId)
      await finishRunCommit(rt, run, finishStageId)
      return
    }
    problems = hard
    issues.forEach((i, idx) => setIssue(rt, { ...i, status: 'failed', title: problems[Math.min(idx, problems.length - 1)] }))
    if (issues[0].attempt >= 2) {
      // 自动修复预算用完 → 问题处理卡片（推荐按规则表）
      run.retryRepair = () => void resumeRepair(rt, run, fixStageId, finishStageId)
      run.proceed = () => void finishRunCommit(rt, run, finishStageId)
      raiseFixProblemCard(rt, run, { ...issues[0] })
      rt.running = false
      return
    }
  }
}

/** 用户选"让 AI 再试一次"（或倒计时自动执行 / 卡点自由输入）：再做一次 LLM 修复 */
async function resumeRepair(rt: Runtime, run: ActiveRun, checkStageId: string, finishStageId: string): Promise<void> {
  rt.running = true
  setStatus(rt, 'generating')
  const issue = rt.s.issues.find((i) => i.id === run.pending.issueId) ?? latestFailedIssue(rt)
  let problems = validateHtml(run.html)
  if (problems.length === 0) {
    // 已经没问题了（比如人工修好后又点了重试），直接收尾
    await finishRunCommit(rt, run, finishStageId)
    return
  }
  if (issue) {
    const next: Issue = { ...issue, attempt: issue.attempt + 1, status: 'fixing', title: problems[0] }
    setIssue(rt, next)
    run.retryLlm = () => void resumeRepair(rt, run, checkStageId, finishStageId)
    const wdFix = armAgentWatchdog(rt, run, checkStageId, 'other')
    const ctlFix = new AbortController()
    run.abort = ctlFix
    try {
      run.html = await callCoderRepair(run.html, problems, llmProgress(rt, checkStageId, '正在修复问题'), ctlFix.signal)
    } catch (err) {
      if (run.watchdogAborted === ctlFix) return // 看门狗已接管（超时卡片）
      setIssue(rt, { ...next, status: 'failed' })
      raiseLlmFailureCard(rt, run, err, checkStageId)
      rt.running = false
      return
    } finally {
      if (run.abort === ctlFix) run.abort = null
      disarmAgentWatchdog(rt, run, wdFix)
    }
    problems = validateHtml(run.html)
    if (problems.length === 0) {
      setIssue(rt, {
        ...next,
        status: 'fixed',
        afterShotUrl: rt.s.dashboard.coverUrl || null,
        detail: 'AI 已重新生成并通过检查。'
      })
      finishStage(rt, checkStageId)
      await finishRunCommit(rt, run, finishStageId)
      return
    }
    const failedNow = { ...next, status: 'failed' as const, title: problems[0] }
    setIssue(rt, failedNow)
    run.retryRepair = () => void resumeRepair(rt, run, checkStageId, finishStageId)
    run.proceed = () => void finishRunCommit(rt, run, finishStageId)
    raiseFixProblemCard(rt, run, failedNow)
    rt.running = false
    return
  }
  await finishRunCommit(rt, run, finishStageId)
}

/** 收尾：生成预览 → 新版本节点 → 空闲 → 处理排队消息 */
async function finishRunCommit(rt: Runtime, run: ActiveRun, finishStageId: string): Promise<void> {
  rt.running = true
  setStatus(rt, 'generating')
  const st = rt.s.stages.find((x) => x.id === finishStageId)
  if (!st || st.state !== 'done') activateStage(rt, finishStageId)
  await sleep(600)
  commitVersion(rt, run)
  finishStage(rt, finishStageId)
  pushAgent(
    rt,
    run.pending.kind === 'create'
      ? '你的大屏做好了！右侧预览可以看看效果，想改哪里直接跟我说。'
      : '改好了，看看效果～想继续调整随时说。'
  )
  completeRun(rt, run)
}

function commitVersion(rt: Runtime, run: ActiveRun): void {
  const dashId = rt.s.dashboard.id
  const n = rt.s.versions.length + 1
  const id = nextId('ver')
  store.writePreview(dashId, id, run.html)
  const url = `/preview/${dashId}/${id}/index.html`
  const v: Version = {
    id,
    label: `v${n}`,
    summary: run.pending.kind === 'create' ? '初版完成' : truncate(run.pending.text) || '修改',
    createdAt: Date.now(),
    screenshotUrl: rt.s.dashboard.coverUrl || coverFor(run.pending.text),
    published: false,
    isCurrent: true
  }
  addVersion(rt, v, url)
  previewReady(rt, id, url)
}

function completeRun(rt: Runtime, run: ActiveRun): void {
  disarmAgentWatchdog(rt, run)
  run.abort = null
  rt.running = false
  rt.activeRun = null
  run.pending.awaiting = null
  rt.s.pendingRun = null
  setStatus(rt, 'idle')
  updateDashboard(rt, {
    status: 'completed',
    coverUrl: rt.s.dashboard.coverUrl || coverFor(run.pending.text)
  })
  drainQueue(rt)
}

/** 生成中排队的话，空闲后合并成一条增量修改处理掉 */
function drainQueue(rt: Runtime): void {
  if (rt.s.runStatus !== 'idle' || rt.queue.length === 0) return
  const items = rt.queue.splice(0, rt.queue.length)
  const text = items.map((i) => i.text).filter(Boolean).join('；')
  const attachments = items.flatMap((i) => i.attachments)
  // 摘掉"排队中"标记
  for (const m of rt.s.messages) {
    if (m.kind === 'user' && m.queued) {
      m.queued = false
      updateMessage(rt, m)
    }
  }
  startEditFlow(rt, text, attachments)
}

/* ============================== 主流程：增量修改（精简 3 步） ============================== */

function startEditFlow(rt: Runtime, text: string, attachments: string[]): void {
  const run: ActiveRun = {
    pending: newPending('edit', text, attachments),
    html: '',
    retryRepair: null,
    retryLlm: null,
    proceed: null
  }
  rt.activeRun = run
  void runEdit(rt, run)
}

async function runEdit(rt: Runtime, run: ActiveRun): Promise<void> {
  rt.running = true
  rt.s.pendingRun = run.pending
  emitPlan(rt, EDIT_TITLES)
  setStatus(rt, 'generating')
  updateDashboard(rt, { status: 'generating' })
  if (rt.s.versions.length > 0) rt.s.preview = { state: 'building', url: rt.s.preview.url }
  pushAgent(
    rt,
    run.pending.text.trim()
      ? `收到，我来调整：「${truncate(run.pending.text)}」，涉及 1 处修改。`
      : '收到，我按你发来的图片做参考来调整，涉及 1 处修改。'
  )

  const cap = await getCapability()
  if (!cap.ok) {
    raiseLlmFailureCard(rt, run, new gw.GatewayError('连不上：地址似乎不对或 Key 无效', '能力探测未通过，请检查设置里的地址和 Key。'), 'st-1')
    run.retryLlm = () => void runEdit(rt, run)
    rt.running = false
    return
  }

  const current = rt.s.versions.find((v) => v.isCurrent) ?? rt.s.versions[0]
  const currentHtml = current ? (store.readPreview(rt.s.dashboard.id, current.id) ?? '') : ''
  if (!currentHtml) {
    // 没有基础版本：退化为新建
    run.pending.kind = 'create'
    await runCreate(rt, run)
    return
  }

  // before: ['st-2'] —— 拆分路径直接接力检查时，先把正常路径的「构建」阶段补打勾，不留永久 pending
  const wdEdit = armAgentWatchdog(rt, run, 'st-1', 'coding', { check: 'st-3', repair: null, finish: 'st-3', before: ['st-2'] })
  const ctl = new AbortController()
  run.abort = ctl
  try {
    run.html = await callCoderEdit(currentHtml, run.pending.text || '按用户发的参考图调整', llmProgress(rt, 'st-1', '正在修改页面'), ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（自动拆分步骤）
    raiseLlmFailureCard(rt, run, err, 'st-1')
    run.retryLlm = () => void runEdit(rt, run)
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdEdit)
  }
  finishStage(rt, 'st-1')
  activateStage(rt, 'st-2')
  await sleep(700)
  finishStage(rt, 'st-2')
  await checkRepairAndFinish(rt, run, 'st-3', null, 'st-3')
}

/* ============================== 消息入口 ============================== */

export function handleSendMessage(dashId: string, text: string, attachments: string[] = []): void {
  const rt = mustRuntime(dashId)
  const queued = rt.s.runStatus === 'generating'
  const msgId = nextId('m')
  pushMessage(rt, {
    kind: 'user',
    id: msgId,
    createdAt: Date.now(),
    text,
    attachmentUrls: attachments,
    queued
  })
  if (queued) {
    rt.queue.push({ text, attachments, messageId: msgId })
    return
  }
  switch (rt.s.runStatus) {
    case 'idle':
      if (rt.s.versions.length === 0) {
        const run: ActiveRun = {
          pending: newPending('create', text, attachments),
          html: '',
          retryRepair: null,
          retryLlm: null,
          proceed: null
        }
        rt.activeRun = run
        void runCreate(rt, run)
      } else {
        startEditFlow(rt, text, attachments)
      }
      break
    case 'awaiting_clarification':
      resolveClarificationWithText(rt, text)
      break
    case 'blocked':
      handleFreeTextDuringBlocked(rt, text)
      break
    case 'assisting':
      pushAgent(rt, '支持人员正在处理，稍等一下～')
      break
  }
}

/* ============================== 澄清回答 ============================== */

export function handleAnswerClarification(dashId: string, messageId: string, answers: ClarificationAnswer[]): void {
  const rt = mustRuntime(dashId)
  if (rt.s.runStatus !== 'awaiting_clarification') return
  const m = rt.s.messages.find((x) => x.id === messageId)
  if (m?.kind === 'clarification') {
    for (const a of answers) {
      const q = m.questions.find((qq) => qq.id === a.questionId)
      if (q) q.answer = a.customText || q.options.find((o) => o.id === a.optionId)?.title || ''
    }
    m.answered = true
    updateMessage(rt, m)
    continueAfterClarification(rt, m)
  }
}

/** 等待澄清时用户直接打字（视为自由回答，UX §4.3 兜底入口） */
function resolveClarificationWithText(rt: Runtime, text: string): void {
  const m = [...rt.s.messages].reverse().find((x): x is ClarificationMessage => x.kind === 'clarification' && !x.answered)
  if (m) {
    m.questions.forEach((q) => {
      if (!q.answer) q.answer = text
    })
    m.answered = true
    updateMessage(rt, m)
  }
  pushAgent(rt, '好的，就按你说的来。')
  continueAfterClarification(rt, m ?? null)
}

function continueAfterClarification(rt: Runtime, m: ClarificationMessage | null): void {
  const run = rt.activeRun ?? rebuildActiveRun(rt)
  if (!run) {
    setBlocker(rt, null)
    setStatus(rt, 'idle')
    return
  }
  rt.activeRun = run
  // 把回答汇总成大白话，带给 coder
  if (m) {
    run.pending.answersSummary = m.questions.map((q) => `「${q.question}」选了「${q.answer ?? ''}」`).join('；')
  }
  run.pending.awaiting = null
  run.pending.clarificationMessageId = null
  setBlocker(rt, null)
  pushAgent(rt, '好的，就按你选的来做，马上开始。')
  void continueCreateToCoding(rt, run)
}

/* ============================== 选项选择（问题卡片 / 卡点行动区共用） ============================== */

export function handleChooseOption(dashId: string, optionId: string, auto = false): void {
  const rt = mustRuntime(dashId)
  if (optionId === 'opt-goto-answer') return // "去回答"由 UI 本地滚动定位，不需要后端动作

  const prob = [...rt.s.messages].reverse().find(
    (m): m is ProblemMessage => m.kind === 'problem' && m.chosenOptionId === null
  )
  const opt = prob?.options.find((o) => o.id === optionId) ?? rt.s.blocker?.options.find((o) => o.id === optionId)
  if (!opt) return

  clearAutoExec(rt)
  if (prob) {
    prob.chosenOptionId = optionId
    updateMessage(rt, prob)
  }
  setBlocker(rt, null)
  pushSystem(rt, auto ? `已自动执行推荐方案：${opt.title}` : `你选择了：${opt.title}`)

  const run = rt.activeRun ?? rebuildActiveRun(rt)
  rt.activeRun = run

  switch (optionId) {
    case 'opt-retry':
    case 'opt-retry-alt':
    case 'opt-retry-llm': {
      const retry = optionId === 'opt-retry-llm' ? run?.retryLlm : (run?.retryRepair ?? run?.retryLlm)
      if (run && retry) {
        run.pending.awaiting = null
        retry()
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-check-settings': {
      pushAgent(rt, '好的，请到「设置」里检查模型地址和 Key，改好后点「让 AI 再试一次」我接着做。')
      if (run) {
        // 重新摆出同一张卡片，等用户改完设置再试
        raiseLlmFailureCard(rt, run, new gw.GatewayError('连不上：等你检查完设置再试', '用户选择先检查模型设置。'), null)
      } else {
        setStatus(rt, 'idle')
      }
      break
    }
    case 'opt-assist':
      startAssistFlow(rt)
      break
    case 'opt-rollback': {
      const target = rt.s.versions.find((v) => v.isCurrent) ?? rt.s.versions[0]
      rt.running = false
      rt.activeRun = null
      rt.s.pendingRun = null
      if (target) {
        doRollback(rt, target.id)
        setStatus(rt, 'idle')
        updateDashboard(rt, { status: 'completed' })
        drainQueue(rt)
      } else {
        setStatus(rt, 'idle')
      }
      break
    }
    case 'opt-custom-generate': {
      if (run) {
        if (run.pending.template) run.pending.template.useTemplate = false
        run.pending.awaiting = null
        void continueCreateToCoding(rt, run)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-use-nearest': {
      if (run) {
        // 用最接近的模板：给默认布局打底
        run.pending.template = { layoutId: 'layoutU', componentIds: [], useTemplate: true }
        run.pending.awaiting = null
        void continueCreateToCoding(rt, run)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-split-redo': {
      if (run) {
        const stageId = run.watchdogStageId ?? (run.pending.kind === 'create' ? 'st-3' : 'st-1')
        void splitCodingFlow(rt, run, stageId)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-reselect-datasource': {
      pushAgent(rt, '好的，已切换到备用数据源（公司车辆平台），继续生成…')
      rt.activeRun = null
      startEditFlow(rt, '接入备用数据源，保证车辆实时位置能正常显示', [])
      break
    }
    default:
      setStatus(rt, 'idle')
      drainQueue(rt)
  }
}

/** 卡点时用户直接打字（视为"再试一次"，UX §4.3 第 4 种选项） */
function handleFreeTextDuringBlocked(rt: Runtime, _text: string): void {
  clearAutoExec(rt)
  const prob = [...rt.s.messages].reverse().find(
    (m): m is ProblemMessage => m.kind === 'problem' && m.chosenOptionId === null
  )
  if (prob) {
    prob.chosenOptionId = 'free-text'
    updateMessage(rt, prob)
  }
  setBlocker(rt, null)
  pushAgent(rt, '好的，按你的想法再试一次。')
  const run = rt.activeRun ?? rebuildActiveRun(rt)
  rt.activeRun = run
  const retry = run?.retryRepair ?? run?.retryLlm
  if (run && retry) {
    run.pending.awaiting = null
    retry()
  } else {
    setStatus(rt, 'idle')
  }
}

export function cancelAutoExec(dashId: string): void {
  const rt = sessions.get(dashId)
  if (rt) clearAutoExec(rt)
}

/** 重启后内存态丢失：按落盘的 pendingRun 重建可续跑的 ActiveRun（最大努力） */
function rebuildActiveRun(rt: Runtime): ActiveRun | null {
  const pending = rt.s.pendingRun
  if (!pending) return null
  const run: ActiveRun = { pending, html: '', retryRepair: null, retryLlm: null, proceed: null }
  const current = rt.s.versions.find((v) => v.isCurrent) ?? rt.s.versions[0]
  run.html = current ? (store.readPreview(rt.s.dashboard.id, current.id) ?? '') : ''
  if (pending.awaiting === 'problem') {
    run.retryRepair = () => void resumeRepair(rt, run, pending.kind === 'create' ? 'st-4' : 'st-3', pending.kind === 'create' ? 'st-5' : 'st-3')
    run.proceed = () => void finishRunCommit(rt, run, pending.kind === 'create' ? 'st-5' : 'st-3')
  } else if (pending.awaiting === 'llm') {
    run.retryLlm =
      pending.kind === 'create' ? () => void runCreate(rt, run) : () => void runEdit(rt, run)
  }
  return run
}

/* ============================== F3 回退 ============================== */

function doRollback(rt: Runtime, versionId: string): void {
  const target = rt.s.versions.find((v) => v.id === versionId)
  if (!target) return
  const html = store.readPreview(rt.s.dashboard.id, versionId)
  if (html === null) return
  const n = rt.s.versions.length + 1
  const id = nextId('ver')
  store.writePreview(rt.s.dashboard.id, id, html) // 复制产物生成新节点，历史不删
  const url = `/preview/${rt.s.dashboard.id}/${id}/index.html`
  const v: Version = {
    id,
    label: `v${n}`,
    summary: `回退到 ${target.label}`,
    createdAt: Date.now(),
    screenshotUrl: target.screenshotUrl,
    published: false,
    isCurrent: true
  }
  addVersion(rt, v, url)
  previewReady(rt, id, url)
  pushSystem(rt, `已回退到 ${target.label} 版本（${target.label} 之后的记录都还在，随时可以回来）`)
  updateDashboard(rt, {})
}

export function handleRollback(dashId: string, versionId: string): void {
  doRollback(mustRuntime(dashId), versionId)
}

/* ============================== F6 发布（5 秒审批模拟） ============================== */

export function handlePublish(dashId: string): void {
  const rt = mustRuntime(dashId)
  if (rt.s.runStatus !== 'idle' || rt.s.versions.length === 0) return
  if (rt.s.stages.some((s) => s.id === 'st-publish' && s.state === 'active')) return
  pushAgent(rt, '已提交发布申请，正在等待审批。通过后会第一时间告诉你。')
  setStage(rt, { id: 'st-publish', title: '等待审批', state: 'active', startedAt: Date.now(), finishedAt: null })
  after(rt, 5000, () => {
    const cur = rt.s.versions.find((v) => v.isCurrent)
    if (cur) upsertVersion(rt, { ...cur, published: true })
    const st = rt.s.stages.find((s) => s.id === 'st-publish')
    if (st) setStage(rt, { ...st, state: 'done', finishedAt: Date.now() })
    pushAgent(rt, '好消息！发布申请已通过，大屏正式发布了。')
    updateDashboard(rt, { status: 'published' })
  })
}

/* ============================== F5 人工协助（客服小李模拟流水） ============================== */

function pushAssistAction(rt: Runtime, text: string): void {
  const cur = rt.s.assistSession
  if (!cur) return
  setAssist(rt, { ...cur, actions: [...cur.actions, { at: Date.now(), text }] })
}

export function startAssistFlow(rtOrId: Runtime | string, note?: string): void {
  const rt = typeof rtOrId === 'string' ? mustRuntime(rtOrId) : rtOrId
  if (rt.s.runStatus === 'assisting') return
  clearAutoExec(rt)
  setBlocker(rt, null)
  setStatus(rt, 'assisting')
  pushSystem(rt, '已通知支持人员，预计 5 分钟内响应，你可以先做别的')
  after(rt, 1000, () => {
    const t0 = Date.now()
    setAssist(rt, { operatorName: '小李', startedAt: t0, actions: [{ at: t0, text: '小李已接入，正在查看执行过程…' }] })
    pushSystem(rt, '支持人员小李已接入')
    after(rt, 2200, () => {
      pushAssistAction(rt, note ? `看了你的留言：「${truncate(note, 20)}」` : '查看了最近的执行记录')
      after(rt, 2400, () => {
        const run = rt.activeRun ?? rebuildActiveRun(rt)
        rt.activeRun = run
        const failed = latestFailedIssue(rt)
        if (failed && run) {
          // 卡点场景：客服帮你修好（确定性清洗兜底），流程继续出预览
          run.html = sanitizeHtml(run.html)
          pushAssistAction(rt, `帮你重试了「${failed.title}」✓ 已修好`)
          setIssue(rt, {
            ...failed,
            status: 'fixed',
            afterShotUrl: rt.s.dashboard.coverUrl || null,
            detail: '支持人员已手动修好。'
          })
          after(rt, 1800, () => {
            pushAssistAction(rt, '问题已解决，把控制权交还给你')
            const proceed = run.proceed ?? (() => void finishRunCommit(rt, run, run.pending.kind === 'create' ? 'st-5' : 'st-3'))
            run.pending.awaiting = null
            proceed()
            after(rt, 3000, () => endAssistQuiet(rt, `协助结束：小李帮你修好了「${failed.title}」。`))
          })
        } else if (run && run.pending.awaiting === 'llm') {
          // LLM 连不上场景：客服协助重试一次
          pushAssistAction(rt, '帮你检查了模型连接，重新发起了一次尝试 ✓')
          after(rt, 1800, () => {
            pushAssistAction(rt, '把控制权交还给你')
            run.pending.awaiting = null
            const retry = run.retryLlm ?? run.retryRepair
            if (retry) retry()
            else setStatus(rt, 'idle')
            after(rt, 3000, () => endAssistQuiet(rt, '协助结束：小李帮你重新发起了生成。'))
          })
        } else {
          // 无事求助：看一圈，报平安
          pushAssistAction(rt, '没有发现需要处理的问题，随时再叫我')
          after(rt, 1800, () => endAssistQuiet(rt, '协助结束：小李检查了一遍，没有发现需要处理的问题。'))
        }
      })
    })
  })
}

function endAssistQuiet(rt: Runtime, summary: string): void {
  setAssist(rt, null)
  pushSystem(rt, summary)
  if (rt.s.runStatus === 'assisting') setStatus(rt, 'idle')
  drainQueue(rt)
}

export function handleEndAssist(dashId: string): void {
  const rt = sessions.get(dashId)
  if (!rt?.s.assistSession) return
  endAssistQuiet(rt, '你已结束协助，控制权已收回。')
}

/* ============================== 会话与 CRUD ============================== */

function emptySession(dash: Dashboard): SessionData {
  return {
    dashboard: dash,
    runStatus: 'idle',
    messages: [],
    stages: [],
    issues: [],
    blocker: null,
    versions: [],
    versionUrls: {},
    preview: { state: 'empty', url: null },
    assistSession: null,
    previewResolution: '1920x1080',
    pendingRun: null
  }
}

function makeRuntime(s: SessionData): Runtime {
  // 重启恢复：进行中的任务状态落回空闲，等待中的卡点保留（靠 pendingRun 重建续跑）
  if (s.runStatus === 'generating' || s.runStatus === 'assisting') {
    s.runStatus = 'idle'
    s.pendingRun = null
  }
  s.assistSession = null
  const rt: Runtime = { s, running: false, queue: [], activeRun: null, autoTimer: null, timers: new Set() }
  sessions.set(s.dashboard.id, rt)
  return rt
}

function mustRuntime(dashId: string): Runtime {
  const rt = sessions.get(dashId)
  if (!rt) throw new HttpError(404, `大屏不存在：${dashId}`)
  return rt
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function snapshotOf(rt: Runtime): WorkbenchSnapshot {
  return {
    dashboard: { ...rt.s.dashboard },
    runStatus: rt.s.runStatus,
    messages: [...rt.s.messages],
    stages: [...rt.s.stages],
    issues: [...rt.s.issues],
    blocker: rt.s.blocker,
    versions: [...rt.s.versions],
    preview: { ...rt.s.preview },
    assistSession: rt.s.assistSession
  }
}

/* ---------- 对外 API ---------- */

export function listDashboards(): Dashboard[] {
  return [...sessions.values()].map((rt) => ({ ...rt.s.dashboard }))
}

function persistDashboards(): void {
  store.saveDashboards(listDashboards())
}

export function createDashboard(name: string): Dashboard {
  const dash: Dashboard = {
    id: nextId('dash'),
    name: name.trim() || '未命名大屏',
    status: 'completed',
    coverUrl: '',
    currentVersionLabel: null,
    updatedAt: Date.now()
  }
  const rt = makeRuntime(emptySession(dash))
  save(rt)
  persistDashboards()
  return { ...dash }
}

export function renameDashboard(id: string, name: string): Dashboard {
  const rt = mustRuntime(id)
  updateDashboard(rt, { name: name.trim() || rt.s.dashboard.name })
  return { ...rt.s.dashboard }
}

export function deleteDashboard(id: string): void {
  const rt = sessions.get(id)
  if (rt) {
    for (const t of rt.timers) clearTimeout(t)
    if (rt.autoTimer) clearTimeout(rt.autoTimer)
    sessions.delete(id)
  }
  store.removeDashboardFiles(id)
  persistDashboards()
}

export function enterDashboard(id: string): WorkbenchSnapshot {
  return snapshotOf(mustRuntime(id))
}

export function listVersions(id: string): Version[] {
  return [...mustRuntime(id).s.versions]
}

export function previewVersion(id: string, versionId: string): void {
  const rt = mustRuntime(id)
  const url = rt.s.versionUrls[versionId]
  if (url) previewReady(rt, versionId, url)
}

export function backToCurrentVersion(id: string): void {
  const rt = mustRuntime(id)
  const cur = rt.s.versions.find((v) => v.isCurrent)
  const url = cur ? rt.s.versionUrls[cur.id] : null
  if (cur && url) previewReady(rt, cur.id, url)
}

export function setPreviewResolution(id: string, resolution: PreviewResolution): void {
  const rt = mustRuntime(id)
  rt.s.previewResolution = resolution
  save(rt)
}

/* ---------- 封面上传 + 导出代码（契约「追加」一节） ---------- */

const COVER_MAX_BYTES = 8 * 1024 * 1024

export function uploadCover(id: string, image: unknown): void {
  const rt = mustRuntime(id)
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(typeof image === 'string' ? image : '')
  if (!m) throw new HttpError(400, '封面图片格式不对：需要 PNG 图片的 dataURL（以 data:image/png;base64 开头）')
  const buf = Buffer.from(m[1], 'base64')
  if (buf.length === 0) throw new HttpError(400, '封面图片是空的，请重新截图后再上传')
  if (buf.length > COVER_MAX_BYTES) throw new HttpError(400, '封面图片太大了：不能超过 8MB，请重新截图后再上传')
  // PNG 魔数：89 50 4E 47
  if (buf.length < 4 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new HttpError(400, '封面图片不是真正的 PNG 文件，请重新截图后再上传')
  }
  store.writeCover(id, buf)
  updateDashboard(rt, { coverUrl: `/covers/${id}.png?t=${Date.now()}` })
}

export function exportVersion(id: string, versionId: string): { filename: string; html: string } {
  const rt = mustRuntime(id)
  const v = rt.s.versions.find((x) => x.id === versionId)
  if (!v) throw new HttpError(404, `版本不存在：${versionId}`)
  const html = store.readPreview(id, versionId)
  if (html === null) throw new HttpError(404, '这个版本的页面文件找不到了，可能已被清理')
  return { filename: `${rt.s.dashboard.name}-${v.label}.html`, html }
}

/* ============================== 初始数据（首次启动种入） ============================== */

const CLIENT_PREVIEW_DIR = path.resolve(process.cwd(), '../client/public/preview')

function seedVersion(rt: Runtime, label: string, summary: string, srcFile: string, published: boolean, isCurrent: boolean, createdAt: number): void {
  const id = `ver-seed-${rt.s.dashboard.id}-${label}`
  store.copyPreview(srcFile, rt.s.dashboard.id, id)
  const url = `/preview/${rt.s.dashboard.id}/${id}/index.html`
  rt.s.versions.push({
    id,
    label,
    summary,
    createdAt,
    screenshotUrl: rt.s.dashboard.coverUrl,
    published,
    isCurrent
  })
  rt.s.versionUrls[id] = url
  if (isCurrent) {
    rt.s.dashboard.currentVersionLabel = label
    rt.s.preview = { state: 'ready', url }
  }
}

function seedDashboard(id: string, name: string, status: Dashboard['status'], coverUrl: string): Runtime {
  const now = Date.now()
  const dash: Dashboard = { id, name, status, coverUrl, currentVersionLabel: null, updatedAt: now }
  const rt = makeRuntime(emptySession(dash))
  rt.s.messages.push({
    kind: 'agent',
    id: nextId('m'),
    createdAt: now,
    text: '你的大屏做好了！右侧预览可以看看效果，想改哪里直接跟我说。'
  })
  return rt
}

function seedIfEmpty(): void {
  if (store.loadDashboards() !== null) return
  const k8sV1 = path.join(CLIENT_PREVIEW_DIR, 'k8s-v1.html')
  const k8sV2 = path.join(CLIENT_PREVIEW_DIR, 'k8s-v2.html')
  const salesV1 = path.join(CLIENT_PREVIEW_DIR, 'sales-v1.html')

  // 1. K8s 集群监控：2 个版本节点，已完成
  const k8s = seedDashboard('dash-k8s', 'K8s 集群监控', 'completed', '/covers/dash-k8s.png')
  seedVersion(k8s, 'v1', '初版完成', k8sV1, false, false, Date.now() - 86_400_000)
  seedVersion(k8s, 'v2', '放大 CPU 图', k8sV2, false, true, Date.now() - 3_600_000)

  // 2. 销售日报：v1 已发布（★）
  const sales = seedDashboard('dash-sales', '销售日报', 'published', '/covers/dash-sales.png')
  seedVersion(sales, 'v1', '初版完成', salesV1, true, true, Date.now() - 172_800_000)

  // 3. 物流追踪：带"数据源不可用"卡点（需要处理）
  const logistics = seedDashboard('dash-logistics', '物流追踪', 'needs_attention', '/covers/dash-logistics.png')
  seedVersion(logistics, 'v1', '初版完成', k8sV1, false, true, Date.now() - 259_200_000)
  const lbOptions = buildProblemOptions('datasource_down', { hasVersion: true, lastVersionLabel: 'v1' }, Date.now())
  const lbMsg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: Date.now(),
    title: '连不上车辆定位数据源',
    description: '车辆定位数据源没有响应，地图上的实时位置画不出来。',
    options: lbOptions,
    chosenOptionId: null,
    relatedIssueId: null
  }
  logistics.s.messages.push(lbMsg)
  logistics.s.blocker = {
    id: nextId('blk'),
    type: 'external',
    title: '数据源连不上',
    description: '车辆定位数据源没有响应，需要换一个数据源才能继续。',
    options: lbOptions,
    relatedMessageId: lbMsg.id
  }
  logistics.s.runStatus = 'blocked'
  logistics.s.pendingRun = {
    kind: 'edit',
    text: '接入备用数据源，保证车辆实时位置能正常显示',
    attachments: [],
    answersSummary: '',
    awaiting: 'problem',
    clarificationMessageId: null,
    failCount: 0,
    issueId: null
  }

  // 4. 能耗分析：1 个版本，已完成
  const energy = seedDashboard('dash-energy', '能耗分析', 'completed', '/covers/dash-energy.png')
  seedVersion(energy, 'v1', '初版完成', salesV1, false, true, Date.now() - 432_000_000)

  for (const rt of [k8s, sales, logistics, energy]) save(rt)
  persistDashboards()
}

/* ============================== 启动 ============================== */

export function boot(): void {
  // 同步模板库（client/templates → data/templates；源缺失时模板匹配自动降级）
  templatesRoot = syncTemplates(dirs.root)
  // 载入设置
  const s = store.loadSettings()
  if (s) cachedSettings = { ...DEFAULT_SETTINGS, ...s }
  // 种入示例大屏（仅首次）
  seedIfEmpty()
  // 恢复会话
  const dashboards = store.loadDashboards<Dashboard>() ?? []
  for (const dash of dashboards) {
    if (sessions.has(dash.id)) continue
    const session = store.loadSession<SessionData>(dash.id)
    if (session) makeRuntime(session)
    else makeRuntime(emptySession(dash))
  }
}
