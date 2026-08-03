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
import { listTools as mcpListTools, callTool as mcpCallTool, invalidateToolsCache, McpError } from './mcp'
import { catalogCount, catalogText, findTemplate, keywordHint, loadTemplateCatalog, syncTemplates, templateImageDataUrl, templatesByType } from './templates'
import { prompt } from './prompts'
import { initAdapterSettings } from './loop-adapter/adapter'
import { inlineDataIntoHtml } from './loop-adapter/shared-utils'
import { projectSlug, publishToAilab, PublishError } from './ailab/publish'
import { artifactPreviewUrl, normalizePreviewUrl } from './preview'
import {
  hydrateDataSourceSecrets,
  hydratePublishConfigSecrets,
  hydrateSettingsSecrets,
  maskDataSources,
  maskPublishConfig,
  maskSettings
} from './secrets'
import { artifactRegistry } from './artifacts/registry'
import { buildBusinessApp, validateBusinessAppBuildInput } from './artifacts/business-app/builder'
import { repairBusinessAppWithModel } from './artifacts/business-app/coder'
import { createBusinessAppSourceArchive } from './artifacts/business-app/exporter'
import { generateBusinessApp } from './artifacts/business-app/generator'
import { analyzeBusinessAppRequirement } from './artifacts/business-app/requirements/analyzer'
import type {
  BusinessApplicationBlueprint,
  BusinessAppChangePlan,
  BusinessAppClarificationTurn,
  BusinessAppRequirementContract,
  BusinessAppRequirementDecision
} from './artifacts/business-app/domain/model'
import { analyzeBusinessAppReference } from './artifacts/business-app/reference'
import type {
  BusinessAppReferenceAnalysis,
  BusinessAppReferenceEvidence
} from './artifacts/business-app/reference'
import { repairBusinessAppDraft } from './artifacts/business-app/repairer'
import { reviewBusinessAppVisual } from './artifacts/business-app/reviewer'
import { validateBuiltBusinessApp } from './artifacts/business-app/validator'
import { skillRegistry } from './skills/registry'
import {
  createLoop,
  type FlowDefinition,
  type GraphCheckpoint,
  type GraphState,
  type NodeExecutor
} from '../../loop-engine/src'
import {
  probeReplicaEnv,
  imageSize,
  cropImageDataUrl,
  renderShotDataUrl,
  fetchGeoJson,
  geojsonToSvgPaths,
  type MapPaths,
  type Region
} from './replica'
import type {
  AgentStep,
  ArtifactKind,
  ArtifactManifest,
  AssistSession,
  Blocker,
  CardOption,
  ChatMessage,
  ClarificationAnswer,
  ClarificationMessage,
  ClarificationQuestion,
  Dashboard,
  DataSourceProbeResult,
  DataUseEntry,
  GraphSnapshot,
  Issue,
  McpAuthType,
  McpDataSource,
  ModelSettings,
  PreviewResolution,
  ProblemMessage,
  PublishConfig,
  PublishPhase,
  PublishProgress,
  RoleModelConfig,
  RunStatus,
  Stage,
  StepState,
  TargetProfile,
  ValidationGateResult,
  ValidationReport,
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
  /**
   * 生成期取数快照（注入 Coder prompt 的真实数据文本块，落盘后重启续跑直接恢复）。
   * undefined = 还没取过（进入「获取数据」阶段要真正取一次）；'' = 取过了但决定用演示数据；
   * 非空 = 取到的真实数据块。编辑/修复/拆分编码一律复用这份快照，不重新取数。
   */
  dataBlock?: string
  /**
   * 本轮取数明细（每条 call 的来源/工具/用途/归一结果/状态），commitVersion 时随版本落盘
   * 并塞进 Version.dataSourcesUsed 供版本抽屉展示。undefined = 还没取过；[] = 用演示数据。
   */
  dataSourcesUsed?: DataUseEntry[]
  /**
   * 参考图精读出的内容清单（复刻模式；随 pendingRun 落盘，重启续跑直接恢复）。
   * undefined = 还没精读过（带图 + 模型能看图时精读一次）；null = 精读失败，按现有流程继续；
   * 非空 = 清单已就绪，Coder 走复刻 prompt。
   */
  inventory?: ReplicaInventory | null
  /** 地图 SVG 路径（GeoJSON 已投影抽稀好，Coder 直接内联用）；null = 备料失败或不需要地图 */
  mapPaths?: MapPaths | null
  /** 规划结论里的省级行政区划代码（无图创作的地图备料依据；'' = 不需要地图） */
  mapAdcode?: string
}

/** 模板匹配环节的结论 */
interface TemplateDecision {
  layoutId: string | null
  /** 模块化匹配结果：每个模块带角色/槽位/数据形态/匹配的模板 id */
  modules: MatchModule[]
  /** false = 用户在"没有匹配"卡片里确认了自定义生成 */
  useTemplate: boolean
}

/** 一个大屏模块（区域/面板）的匹配结论 */
interface MatchModule {
  /** 模块角色（大白话，如"顶部指标条""中央拓扑"） */
  role: string
  /** 槽位：top|left|center|right|bottom */
  slot: string
  /** 数据形态：metric|records|topology|... */
  dataKind: string
  /** 匹配到的组件模板 id，null=无合适模板（该模块自定义） */
  templateId: string | null
  /** 一句话匹配理由 */
  reason: string
}

/** 工作台会话快照（sessions/<id>.json 落盘内容） */
interface SessionData {
  dashboard: Dashboard
  runStatus: RunStatus
  messages: ChatMessage[]
  stages: Stage[]
  /** 执行轨迹（各阶段节点下的动作流；观测性设计 §2.3 用户态投影） */
  steps: AgentStep[]
  issues: Issue[]
  blocker: Blocker | null
  versions: Version[]
  /** 版本产物相对路径（/preview/<dashId>/<verId>/index.html） */
  versionUrls: Record<string, string>
  preview: { state: 'empty' | 'building' | 'ready'; url: string | null }
  /** LoopEngine 流程图快照（调试面板用，由 adapter 同步进来；刷新恢复用） */
  graph: GraphSnapshot | null
  assistSession: AssistSession | null
  previewResolution: PreviewResolution
  pendingRun: PendingRun | null
  /** 最近一次生成期取数的快照（'' = 上次决定用演示数据）；编辑流复用它，不重新取数 */
  lastDataBlock?: string
  /** 最近一次生成期取数的明细（与 lastDataBlock 同源；编辑流复用，让新版本也能展示数据来源） */
  lastDataSourcesUsed?: DataUseEntry[]
  /** 业务应用的累计需求与未完成候选，保证“继续”不会开启一轮失忆的全量生成。 */
  businessAppState?: BusinessAppProjectState
}

/**
 * business-app 跨轮次持久化状态。
 *
 * 已提交蓝图与未通过验收的候选蓝图分开保存；澄清问题、用户决策和纯 JSON 检查点用于服务重启后续跑。
 */
interface BusinessAppProjectState {
  requirements: string[]
  activeRequirement: string | null
  candidateRevisionId: string | null
  unresolved: boolean
  strategiesTried: string[]
  lastFailure: string | null
  decisions: BusinessAppRequirementDecision[]
  requirementContract: BusinessAppRequirementContract | null
  blueprint: BusinessApplicationBlueprint | null
  changePlan: BusinessAppChangePlan | null
  candidateBlueprint: BusinessApplicationBlueprint | null
  candidateChangePlan: BusinessAppChangePlan | null
  pendingClarification: BusinessAppClarificationTurn | null
  checkpoint: GraphCheckpoint | null
  reference?: {
    analysis: BusinessAppReferenceAnalysis
    evidence: BusinessAppReferenceEvidence
  }
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
  /** 新一轮已清空执行轨迹：下一个 step 事件要带 reset=true 让客户端同步清空 */
  stepsResetPending: boolean
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

function targetProfileFor(kind: ArtifactKind): TargetProfile {
  return artifactRegistry.get(kind).createTargetProfile()
}

function manifestFor(kind: ArtifactKind): ArtifactManifest {
  return artifactRegistry.get(kind).createManifest()
}

function passedValidationReport(detail = '已通过当前产物类型的全部门禁'): ValidationReport {
  return {
    status: 'passed',
    gates: [
      { id: 'legacy-validation', title: '产物检查', status: 'passed', detail }
    ]
  }
}

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

/* ---------- 执行轨迹（AgentStep，观测性设计 §2.3：文案在写入时固化成大白话，前端只渲染不翻译） ---------- */

function setStep(rt: Runtime, step: AgentStep, reset: boolean): void {
  if (reset) rt.s.steps = []
  const i = rt.s.steps.findIndex((x) => x.id === step.id)
  if (i >= 0) rt.s.steps[i] = step
  else rt.s.steps.push(step)
  store.emit(rt.s.dashboard.id, 'step', { dashboardId: rt.s.dashboard.id, step, reset })
  save(rt)
}

/** 开始一个动作（新一轮的第一个动作带上 reset，清掉上一轮的轨迹） */
function startStep(rt: Runtime, stageId: string, title: string): AgentStep {
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
  setStep(rt, step, reset)
  return step
}

/** 结束一个动作：detail 为结果摘要（大白话）。state 默认 done；failed 只用于导致卡点/卡片的真实失败 */
function finishStep(rt: Runtime, step: AgentStep, detail: string | null = null, state: StepState = 'done'): void {
  setStep(rt, { ...step, state, detail, finishedAt: Date.now() }, false)
}

/** 兜底关闭某阶段仍在进行中的动作（看门狗接管、失败重试等边缘路径不留"永远转圈"） */
function closeOrphanSteps(rt: Runtime, stageId: string, state: StepState, detail: string | null): void {
  for (const orphan of rt.s.steps.filter((x) => x.stageId === stageId && x.state === 'active')) {
    setStep(rt, { ...orphan, state, detail, finishedAt: Date.now() }, false)
  }
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
  rt.s.dashboard.currentRevisionId = v.id
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
 *   数据源不可用    → ★ 改用演示数据继续（"先把页面做出来，数据源恢复了再换真数据"），另给 再试一次 / 呼叫人工
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
          id: 'opt-demo-data',
          title: '改用演示数据继续',
          consequence: '先用看着合理的演示数据把大屏做出来，数据源恢复了随时可以换成真数据',
          recommended: true,
          recommendReason: '不卡在数据源上，先把页面做出来最快',
          riskLevel: 'low',
          autoExecuteAt: null
        },
        {
          id: 'opt-retry-datasource',
          title: '再试一次取数',
          consequence: '重新连一次数据源，通常几秒到一分钟',
          recommended: false,
          recommendReason: null,
          riskLevel: 'low',
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

const EMPTY_ROLE: RoleModelConfig = { model: '', apiBase: '', apiKey: '' }

const DEFAULT_SETTINGS: ModelSettings = {
  provider: '公司内置',
  apiBase: '',
  apiKey: '',
  model: '',
  planner: { ...EMPTY_ROLE },
  coder: { ...EMPTY_ROLE },
  vision: { ...EMPTY_ROLE }
}

/**
 * 兼容旧版设置文件：plannerModel/coderModel/visionModel 字符串字段 → 角色配置对象。
 * 旧文件里角色只能换模型名，迁移为 { model: 旧值, apiBase: '', apiKey: '' }（地址/Key 跟随主设置）。
 */
function normalizeSettings(raw: ModelSettings): ModelSettings {
  const legacy = raw as unknown as Record<string, unknown>
  const role = (cfg: unknown, legacyModel: unknown): RoleModelConfig => {
    const c = (cfg && typeof cfg === 'object' ? cfg : {}) as Partial<RoleModelConfig>
    return {
      model:
        typeof c.model === 'string' && c.model
          ? c.model
          : typeof legacyModel === 'string'
            ? legacyModel
            : '',
      apiBase: typeof c.apiBase === 'string' ? c.apiBase : '',
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : ''
    }
  }
  return {
    ...raw,
    planner: role(raw.planner, legacy.plannerModel),
    coder: role(raw.coder, legacy.coderModel),
    vision: role(raw.vision, legacy.visionModel)
  }
}

let cachedSettings: ModelSettings = { ...DEFAULT_SETTINGS }

/** 能力画像缓存：设置内容变 → 重新探测（SYSTEM_DESIGN §3.3 声明 + 探测） */
let capabilityCache: { key: string; ok: boolean; supportsVision: boolean } | null = null
let capabilityPending: Promise<{ ok: boolean; supportsVision: boolean }> | null = null

export function getSettings(): ModelSettings {
  return maskSettings(cachedSettings)
}

export function saveSettings(s: ModelSettings): void {
  // 兼容旧客户端可能还发 plannerModel 字符串字段的情况
  const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...s })
  cachedSettings = hydrateSettingsSecrets(normalized, cachedSettings)
  store.saveSettings(cachedSettings)
  capabilityCache = null
  initAdapterSettings(cachedSettings, cachedDataSources, templatesRoot)
}

export function resolveSettingsSecrets(s: ModelSettings): ModelSettings {
  const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...s })
  return hydrateSettingsSecrets(normalized, cachedSettings)
}

/* ------------------------------ 发布配置（云配置） ------------------------------ */

const DEFAULT_PUBLISH_CONFIG: PublishConfig = { endpoint: '', accessKey: '', secretKey: '' }

/** normalize：补全缺字段、强制字符串类型，避免脏文件导致后续发布流程异常 */
function normalizePublishConfig(raw: PublishConfig): PublishConfig {
  return {
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    accessKey: typeof raw.accessKey === 'string' ? raw.accessKey : '',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey : ''
  }
}

let cachedPublishConfig: PublishConfig = { ...DEFAULT_PUBLISH_CONFIG }

export function getPublishConfig(): PublishConfig {
  return maskPublishConfig(cachedPublishConfig)
}

export function savePublishConfig(c: PublishConfig): void {
  cachedPublishConfig = normalizePublishConfig(
    hydratePublishConfigSecrets(
      { ...DEFAULT_PUBLISH_CONFIG, ...c },
      cachedPublishConfig
    )
  )
  store.savePublishConfig(cachedPublishConfig)
}

/** 能力协商（§4.2）：任务启动时探测一次，结果缓存到下次设置变更 */
export async function getCapability(): Promise<{ ok: boolean; supportsVision: boolean }> {
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

/* ============================== MCP 数据源 ============================== */

let cachedDataSources: McpDataSource[] = []

/** 兜底规整：非数组→空数组；元素字段逐个兜底；id 缺失自动生成 */
function normalizeDataSources(raw: unknown): McpDataSource[] {
  if (!Array.isArray(raw)) return []
  const out: McpDataSource[] = []
  for (const item of raw) {
    const s = (item && typeof item === 'object' ? item : {}) as Partial<McpDataSource>
    const authType: McpAuthType =
      s.authType === 'bearer' || s.authType === 'header' || s.authType === 'hmac' ? s.authType : 'none'
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : nextId('ds'),
      name: typeof s.name === 'string' ? s.name : '',
      url: typeof s.url === 'string' ? s.url : '',
      authType,
      token: typeof s.token === 'string' ? s.token : '',
      headerName: typeof s.headerName === 'string' ? s.headerName : '',
      accessKey: typeof s.accessKey === 'string' ? s.accessKey : '',
      secretKey: typeof s.secretKey === 'string' ? s.secretKey : '',
      enabled: s.enabled !== false
    })
  }
  return out
}

export function getDataSources(): McpDataSource[] {
  return maskDataSources(cachedDataSources)
}

/** 全量保存（与模型设置同风格：PUT 整份列表），保存时失效 listTools 缓存 */
export function saveDataSources(list: unknown): McpDataSource[] {
  cachedDataSources = hydrateDataSourceSecrets(normalizeDataSources(list), cachedDataSources)
  store.saveDataSources(cachedDataSources)
  invalidateToolsCache()
  initAdapterSettings(cachedSettings, cachedDataSources, templatesRoot)
  return getDataSources()
}

/** 「测试数据源连接」：真实调 tools/list 探测，永不抛错（错误体现在 ok=false） */
export async function probeDataSource(source: unknown): Promise<DataSourceProbeResult> {
  const [normalized] = normalizeDataSources([source])
  const [s] = hydrateDataSourceSecrets([normalized], cachedDataSources)
  if (!s.url) {
    return { ok: false, tools: [], message: '先填一下数据源地址再测试', detail: null }
  }
  try {
    const tools = await mcpListTools(s)
    // 探测成功后失效缓存：下次取数拿到的是最新工具列表
    invalidateToolsCache(s)
    const names = tools.map((t) => t.name)
    return {
      ok: true,
      tools: names,
      message: names.length > 0 ? `连接成功，发现 ${names.length} 个可用工具` : '连接成功，但数据源没有提供可用工具',
      detail: null
    }
  } catch (err) {
    const message = err instanceof McpError ? err.message : '连不上数据源：出了点意外情况'
    const detail =
      err instanceof McpError
        ? err.detail
        : err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err)
    return { ok: false, tools: [], message, detail }
  }
}

/* ============================== 阶段时间线 ============================== */

const CREATE_TITLES = ['理解需求', '匹配模板', '获取数据', '编写页面', '视觉检查', '修复问题', '生成预览']
const CREATE_TITLES_NO_DATA = ['理解需求', '匹配模板', '编写页面', '视觉检查', '修复问题', '生成预览']
const CREATE_TITLES_WITH_IMAGE = ['分析参考图片', '匹配模板', '获取数据', '编写页面', '视觉检查', '修复问题', '生成预览']
const CREATE_TITLES_WITH_IMAGE_NO_DATA = ['分析参考图片', '匹配模板', '编写页面', '视觉检查', '修复问题', '生成预览']
const EDIT_TITLES = ['修改', '构建', '检查']

/** 是否配置了启用的数据源（决定新建流程要不要多一段「获取数据」） */
function hasEnabledDataSources(): boolean {
  return cachedDataSources.some((s) => s.enabled && !!s.url)
}

/** 新建流程的阶段标题：有启用数据源 7 段，否则沿用旧 6 段（emitPlan 会抹掉多余槽位） */
function createTitles(hasImage: boolean): string[] {
  const hasDs = hasEnabledDataSources()
  if (hasImage) return hasDs ? CREATE_TITLES_WITH_IMAGE : CREATE_TITLES_WITH_IMAGE_NO_DATA
  return hasDs ? CREATE_TITLES : CREATE_TITLES_NO_DATA
}

/** 新建流程各阶段 id：有数据源时多一段「获取数据」，后续阶段顺延 */
function createStageIds(): { fetch: string | null; code: string; check: string; repair: string; finish: string } {
  return hasEnabledDataSources()
    ? { fetch: 'st-3', code: 'st-4', check: 'st-5', repair: 'st-6', finish: 'st-7' }
    : { fetch: null, code: 'st-3', check: 'st-4', repair: 'st-5', finish: 'st-6' }
}

function emitPlan(rt: Runtime, titles: string[]): void {
  // 新一轮开始：清空上一轮的执行轨迹（下一个动作事件带 reset=true，客户端同步清空）
  rt.s.steps = []
  rt.stepsResetPending = true
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
  // 重进同一阶段（失败重试/看门狗接管后）：上一轮没闭环的动作标记中断，不留"永远转圈"
  closeOrphanSteps(rt, id, 'failed', '中断了，重新开始')
  setStage(rt, { ...st, state: 'active', startedAt: Date.now(), finishedAt: null, detail: null })
}

function finishStage(rt: Runtime, id: string): void {
  const st = rt.s.stages.find((x) => x.id === id)
  if (!st || !st.title) return
  // 兜底：阶段结束时仍有进行中的动作，按完成关闭（正常路径各动作都已单独闭环）
  closeOrphanSteps(rt, id, 'done', null)
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
    const url = artifactPreviewUrl(dashId, 'building', n)
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
  const fallbackIds = createStageIds()
  const ids = run.checkIds ?? { check: fallbackIds.check, repair: fallbackIds.repair, finish: fallbackIds.finish }
  /** 接力检查前，把正常路径会走、拆分路径跳过的阶段补打勾（如编辑流的「构建」st-2） */
  const finishBeforeStages = (): void => {
    for (const id of ids.before ?? []) {
      activateStage(rt, id)
      finishStage(rt, id)
    }
  }

  // 拆分编码复用生成时落盘的数据快照（run.pending.dataBlock），不重新取数
  const dataPart = run.pending.dataBlock ? `\n\n${run.pending.dataBlock}` : ''
  const requirement =
    run.pending.kind === 'create'
      ? `请做这样一个大屏：${run.pending.text}${run.pending.answersSummary ? `\n用户确认的偏好：${run.pending.answersSummary}` : ''}${dataPart}`
      : editRequirement(rt, run) + dataPart

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
    const step = startStep(rt, stageId, label)
    try {
      const out = await gw.chatCompletionStream(
        cachedSettings,
        {
          role: 'coder',
          messages: [
            { role: 'system', content: prompt('coder.system') },
            { role: 'user', content: userContent }
          ],
          maxTokens: CODER_MAX_TOKENS,
          signal: ctl.signal
        },
        (chars, partial) => {
          progress(chars)
          onPartial?.(partial)
        }
      )
      finishStep(rt, step, '完成了')
      return out
    } catch (err) {
      if (run.watchdogAborted === ctl) return null
      finishStep(rt, step, '没完成', 'failed')
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
  /** 省级行政区划代码（需求涉及地图且能判断到省时；'' = 不需要地图备料） */
  mapAdcode: string
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
  const mapAdcodeRaw = typeof obj.mapAdcode === 'string' ? obj.mapAdcode.trim() : ''
  return {
    analysis,
    needClarification: obj.needClarification === true && questions.length > 0,
    intro,
    questions,
    mapAdcode: /^\d{6}$/.test(mapAdcodeRaw) ? mapAdcodeRaw : ''
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

/* ============================== LLM：参考图精读（复刻模式） ============================== */

/** 参考图精读出的内容清单（replica.inventory prompt 的 JSON 契约，规范化后形态） */
interface ReplicaInventory {
  title: string
  layout: string
  panels: Array<{ name: string; position: string; content: string }>
  kpis: string[]
  colors: string
  hasMap: boolean
  mapAdcode: string
  mapCities: string[]
  notes: string
}

/** 精读结果规范化：字段逐个兜底；mapAdcode 只认 6 位数字行政区划代码，否则清空（备料环节按空跳过） */
function normalizeReplicaInventory(raw: unknown): ReplicaInventory {
  const o = (raw ?? {}) as Record<string, unknown>
  const panels = (Array.isArray(o.panels) ? o.panels : [])
    .slice(0, 12)
    .map((p) => {
      const x = (p ?? {}) as Record<string, unknown>
      return {
        name: String(x.name ?? '').trim(),
        position: String(x.position ?? '').trim(),
        content: String(x.content ?? '').trim()
      }
    })
    .filter((p) => p.name || p.content)
  const kpis = (Array.isArray(o.kpis) ? o.kpis : [])
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 12)
  const mapCities = (Array.isArray(o.mapCities) ? o.mapCities : [])
    .map((c) => String(c).trim())
    .filter(Boolean)
    .slice(0, 40)
  let mapAdcode = String(o.mapAdcode ?? '').trim()
  if (!/^\d{6}$/.test(mapAdcode)) mapAdcode = ''
  return {
    title: String(o.title ?? '').trim(),
    layout: String(o.layout ?? '').trim(),
    panels,
    kpis,
    colors: String(o.colors ?? '').trim(),
    hasMap: o.hasMap === true,
    mapAdcode,
    mapCities,
    notes: String(o.notes ?? '').trim()
  }
}

/**
 * 参考图局部裁剪区域：顶条 / 左栏 / 中部 / 右栏 / 底部 共 5 块。
 * 全部按比例换算并夹紧到图片范围内，任何尺寸（含非 16:9 截图）都不会越界。
 */
function referenceRegions(width: number, height: number): Region[] {
  const topH = Math.max(1, Math.round(height * 0.14))
  const bottomH = Math.max(1, Math.round(height * 0.2))
  const colW = Math.max(1, Math.round(width / 3))
  const midH = Math.max(1, height - topH - bottomH)
  const mk = (left: number, top: number, w: number, h: number): Region => {
    const l = Math.min(Math.max(0, Math.round(left)), width - 1)
    const t = Math.min(Math.max(0, Math.round(top)), height - 1)
    return { left: l, top: t, width: Math.max(1, Math.min(Math.round(w), width - l)), height: Math.max(1, Math.min(Math.round(h), height - t)) }
  }
  return [
    mk(0, 0, width, topH),
    mk(0, topH, colW, midH),
    mk(colW, topH, width - colW * 2, midH),
    mk(width - colW, topH, colW, midH),
    mk(0, height - bottomH, width, bottomH)
  ]
}

/**
 * 精读参考图（vision 角色）：原图 + 局部放大裁剪图一起给模型，输出内容清单 JSON。
 * JSON 容错提取沿用网关的 extractJson 手法；失败抛错由调用方兜底（inventory=null 继续，不阻塞）。
 */
async function callReplicaInventory(
  referenceImage: string,
  crops: string[],
  requirement: string,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<ReplicaInventory> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    {
      type: 'text',
      text: prompt('replica.inventory.user', { requirement: requirement || '（用户只发了图片，没有文字）' })
    },
    { type: 'image_url', image_url: { url: referenceImage } }
  ]
  for (const url of crops) content.push({ type: 'image_url', image_url: { url } })
  const reply = await gw.chatCompletionStream(
    cachedSettings,
    {
      role: 'vision',
      messages: [
        { role: 'system', content: prompt('replica.inventory.system') },
        { role: 'user', content }
      ],
      signal
    },
    onProgress ?? (() => {})
  )
  return normalizeReplicaInventory(gw.extractJson(reply))
}

/** 注入复刻 Coder prompt 的地图说明：用法一句大白话 + 路径 JSON（截断 60KB 防爆 prompt） */
function mapNoteText(mapPaths: MapPaths): string {
  return prompt('coder.map-note', { mapPathsJson: truncateBytes(JSON.stringify(mapPaths), 60 * 1024) })
}

/** 复刻上下文：有清单才走复刻 prompt；referenceImage 仅当模型能看图时带上 */
interface ReplicaContext {
  inventory: ReplicaInventory
  referenceImage: string | null
  mapPaths: MapPaths | null
}

/* ============================== LLM：Coder ============================== */

async function callCoderCreate(
  text: string,
  answersSummary: string,
  template: TemplateDecision | null | undefined,
  vision: boolean,
  dataBlock: string,
  replica: ReplicaContext | null,
  mapPaths: MapPaths | null,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<string> {
  // 复刻分支：有精读清单 → 用复刻 prompt，清单数值照抄 + 参考图一起给（模型能看图才带图）
  if (replica) {
    const userText = prompt('coder.replica.user', {
      requirement: text || '（用户只发了图片，没有文字）',
      answers: answersSummary ? prompt('coder.create.answers-block', { answersSummary }) : '',
      inventory: JSON.stringify(replica.inventory, null, 2),
      dataBlock,
      mapNote: replica.mapPaths ? mapNoteText(replica.mapPaths) : ''
    })
    const content: LlmUserContent = replica.referenceImage
      ? [
          { type: 'text', text: userText },
          { type: 'image_url' as const, image_url: { url: replica.referenceImage } }
        ]
      : userText
    const reply = await gw.chatCompletionStream(cachedSettings, {
      role: 'coder',
      messages: [
        // 复刻 = 通用大屏开发规范（重写版 coder.system）+ 复刻增量要求，两段串成一份 system
        { role: 'system', content: `${prompt('coder.system')}\n\n${prompt('coder.replica.system')}` },
        { role: 'user', content }
      ],
      maxTokens: CODER_MAX_TOKENS,
      signal
    }, onProgress ?? (() => {}))
    return gw.extractHtml(reply)
  }
  const tpl = template ? templateContext(template, vision, dataBlock) : { text: '', images: [] }
  let userText = prompt('coder.create.user', {
    text,
    answersBlock: answersSummary ? prompt('coder.create.answers-block', { answersSummary }) : '',
    templateContext: tpl.text,
    dataBlock,
    imageNote: tpl.images.length > 0 ? prompt('coder.create.image-note') : ''
  })
  // 无图创作也可能有地图备料（规划结论给了行政区划代码）：把投影好的路径拼进 user
  if (mapPaths) userText += `\n\n${mapNoteText(mapPaths)}`
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
    maxTokens: CODER_MAX_TOKENS,
    signal
  }, onProgress ?? (() => {}))
  return gw.extractHtml(reply)
}

async function callCoderEdit(currentHtml: string, instruction: string, dataBlock: string, onProgress?: (chars: number, partial: string) => void, signal?: AbortSignal): Promise<string> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'coder',
    messages: [
      { role: 'system', content: prompt('coder.system') },
      {
        role: 'user',
        content: prompt('coder.edit.user', { currentHtml, instruction, dataBlock })
      }
    ],
    maxTokens: CODER_MAX_TOKENS,
    signal
  }, onProgress ?? (() => {}))
  return gw.extractHtml(reply)
}

async function callCoderRepair(html: string, problems: string[], dataBlock: string, onProgress?: (chars: number, partial: string) => void, signal?: AbortSignal): Promise<string> {
  const reply = await gw.chatCompletionStream(cachedSettings, {
    role: 'coder',
    messages: [
      { role: 'system', content: prompt('coder.system') },
      {
        role: 'user',
        content: prompt('coder.repair.user', { problems: problems.map((p) => `- ${p}`).join('\n'), html, dataBlock })
      }
    ],
    maxTokens: CODER_MAX_TOKENS,
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
  modules: MatchModule[]
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
      for (const l of templatesByType('layout')) {
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
  // 校验 layoutId 在目录里；modules 逐条校验 templateId（null 保留=自定义，非空必须在目录里）
  const layoutId =
    typeof parsed.layoutId === 'string' && findTemplate(parsed.layoutId)?.type === 'layout' ? parsed.layoutId : null
  const rawModules: unknown[] = Array.isArray(parsed.modules) ? parsed.modules : []
  const modules: MatchModule[] = rawModules
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    .map((m): MatchModule => ({
      role: typeof m.role === 'string' ? m.role : '',
      slot: typeof m.slot === 'string' ? m.slot : '',
      dataKind: typeof m.dataKind === 'string' ? m.dataKind : '',
      templateId:
        typeof m.templateId === 'string' && findTemplate(m.templateId)?.type === 'component' ? m.templateId : null,
      reason: typeof m.reason === 'string' ? m.reason : ''
    }))
    .filter((m) => m.role) // 没角色的模块丢弃
  return {
    layoutId,
    modules,
    unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched.map(String).filter(Boolean) : []
  }
}

/**
 * 从 dataBlock（buildDataBlock 产出的文本）里提取"指标名=数值"的精简摘要，
 * 用于在模板注入时把真数据贴到每个模块标注旁边，防止 Coder 照抄模板演示数字。
 * 解析 dataBlock 里的 JSON 数组，每条取 rows[0] 的字段拼成 "字段名=值" 列表。
 */
function extractDataSummary(dataBlock: string): string {
  if (!dataBlock) return ''
  const idx = dataBlock.lastIndexOf('\n[')
  if (idx < 0) return ''
  let partial = dataBlock.slice(idx).trim()
  const lastClose = partial.lastIndexOf('}')
  if (lastClose < 0) return ''
  partial = partial.slice(0, lastClose + 1) + ']'
  let arr: Array<{ 用途?: string; kind?: string; 数据?: { rows?: Array<Record<string, unknown>>; layers?: unknown[] } }>
  try {
    arr = JSON.parse(partial)
  } catch {
    return '' // 截断的 JSON 解析失败，放弃
  }
  const lines: string[] = []
  for (const item of arr) {
    const purpose = (item.用途 || '').replace(/^⚠️非标准结构\s*/, '').slice(0, 30)
    const rows = item.数据?.rows
    if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object') {
      const vals = Object.entries(rows[0] as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && /^\d+\.?\d*$/.test(v)))
        .map(([k, v]) => `${k}=${v}`)
        .join('、')
      if (vals) lines.push(`- ${purpose}：${vals}`)
    } else if (item.kind === 'topology' && Array.isArray(item.数据?.layers)) {
      lines.push(`- ${purpose}：拓扑数据（见上方数据块）`)
    }
  }
  return lines.join('\n')
}

/**
 * 模板上下文：注入 Coder prompt 的布局 HTML + 各模块组件 HTML + 参考图（vision 时）。
 * 重构后直接注入匹配到的模板 HTML 全文（不再只发一句话描述），Coder 照 HTML 还原样式。
 * ★关键★：dataBlock 的真数据摘要嵌入每个模块标注，防止 Coder 照抄模板演示数字。
 */
function templateContext(dec: TemplateDecision, vision: boolean, dataBlock: string): { text: string; images: string[] } {
  if (!dec.useTemplate) return { text: '', images: [] }
  const layout = dec.layoutId ? findTemplate(dec.layoutId) : undefined
  const moduleEntries = dec.modules
    .map((m) => ({ m, t: m.templateId ? findTemplate(m.templateId) : undefined }))
    .filter((x) => x.t)
  if (!layout && moduleEntries.length === 0) return { text: '', images: [] }

  // 真数据摘要（贴到模板注入文本开头，让 Coder 看模板时就能看到所有真数值）
  const dataSummary = extractDataSummary(dataBlock)
  const summaryNote = dataSummary
    ? `\n\n★本大屏要用的真实数值（必须用这些，禁止照抄模板里的占位数字）★：\n${dataSummary}`
    : ''
  // 拼注入文本：layout HTML 全量 + 每个模块的 HTML + 角色/槽位标注
  const parts: string[] = []
  if (layout) {
    parts.push(`【布局模板：${layout.name}，照它的网格结构排版（模板里的数字是占位演示，不要照抄）】\n${layout.html}`)
  }
  for (const { m, t } of moduleEntries) {
    const slotNote = m.slot ? `，画在${m.slot}位置` : ''
    const kindNote = m.dataKind ? `，数据形态${m.dataKind}` : ''
    parts.push(`【模块「${m.role}」模板：${t!.name}${slotNote}${kindNote}，照样式画但数值必须用上方真实数值，禁止照抄模板数字】\n${t!.html}`)
  }
  const text = `【模板库匹配结果：照下面的模板 HTML 还原样式（CSS/结构/配色/图表形态），保证视觉还原度。但是--模板 HTML 里的所有数字都是占位演示数据，禁止照抄！页面上显示的每个数值都必须来自「真实数据」块，用真数据替换模板里的占位数字。${summaryNote}】\n${parts.join('\n\n')}`

  // vision 模式附 PNG（layout + 各模块代表图，作为视觉参考）
  const images: string[] = []
  if (vision && templatesRoot) {
    const rels = [layout?.image, ...moduleEntries.map((x) => x.t!.image)].filter((r): r is string => Boolean(r))
    for (const rel of rels) {
      const dataUrl = templateImageDataUrl(templatesRoot, rel.replace(/^\//, ''))
      if (dataUrl) images.push(dataUrl)
    }
  }
  return { text, images }
}

/* ============================== LLM：取数规划（MCP 数据源） ============================== */

/** 取数规划里的一条调用（白名单过滤后的合法形态） */
interface DataFetchCall {
  sourceId: string
  tool: string
  args: Record<string, unknown>
  purpose: string
}

/** 数据块截断上限（默认 8KB，环境变量可调）：防止取回的数据把 Coder prompt 撑爆 */
const DATA_BLOCK_MAX_BYTES = Number(process.env.DATA_BLOCK_MAX_BYTES) || 8 * 1024

/**
 * Coder 单次生成的最大 token 数（环境变量可调）。
 * 大屏 HTML 含内联 CSS/SVG/JS，较长；不传 max_tokens 时模型用默认值（glm-5.2 约 4K），
 * 会写到一半被截断（只剩 CSS、body 没生成 -> 黑屏）。SVG 路径数据（折线图坐标）极耗 token，
 * 32000 覆盖含多图表的复杂大屏。模型若不支持该上限会被自身 cap，不影响。
 */
const CODER_MAX_TOKENS = Number(process.env.CODER_MAX_TOKENS) || 32_000

/** 注入 prompt 前剥掉 http(s):// 开头的网址（防止模型照抄进 HTML 后被 validateHtml 当外部资源引用拦截） */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, '（网址已省略）')
}

/** 按字节截断 UTF-8 文本（Buffer 截断可能切出半个字，toString 会收成替换符，可接受） */
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…（数据太长，已截断）`
}

/** 取数规划确定性规范化：白名单过滤（sourceId/tool 必须在已配置且启用的清单内，非法丢弃），calls 上限 3 */
function normalizeDataFetchCalls(raw: unknown, whitelist: Map<string, Set<string>>): DataFetchCall[] {
  const obj = (raw ?? {}) as Record<string, unknown>
  const arr = Array.isArray(obj.calls) ? obj.calls : []
  const out: DataFetchCall[] = []
  for (const item of arr) {
    if (out.length >= 6) break
    const c = (item ?? {}) as Record<string, unknown>
    if (typeof c.sourceId !== 'string' || typeof c.tool !== 'string') continue
    const tools = whitelist.get(c.sourceId)
    if (!tools || !tools.has(c.tool)) continue
    out.push({
      sourceId: c.sourceId,
      tool: c.tool,
      args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {},
      purpose: typeof c.purpose === 'string' ? c.purpose.trim() : ''
    })
  }
  return out
}

/** 取数规划 LLM 调用：与 callTemplateMatch 同构（planner 角色 + extractJson，规范化交给调用方） */
async function callDataFetchPlan(
  text: string,
  answersSummary: string,
  toolsCatalog: string,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal,
  /** 纠错轮用：上一轮各 callTool 的执行结果原文（含错误+hint）。首轮不传，行为不变。 */
  previousAttempts?: string
): Promise<unknown> {
  const reply = await gw.chatCompletionStream(
    cachedSettings,
    {
      role: 'planner',
      messages: [
        { role: 'system', content: prompt('datasource.plan.system') },
        {
          role: 'user',
          content: prompt('datasource.plan.user', {
            text: text || '（用户只发了图片，没有文字）',
            answersBlock: answersSummary ? prompt('coder.create.answers-block', { answersSummary }) : '',
            toolsCatalog,
            previousAttempts: previousAttempts ?? ''
          })
        }
      ],
      signal
    },
    onProgress ?? (() => {})
  )
  return gw.extractJson(reply)
}

/**
 * 把单条工具返回归一成 Coder 能稳定识别的结构。
 * 不依赖外部 Schema，纯代码按字段特征判定 kind：
 *   - metric    : { rows:[], schema:{}, meta:{} } -- query_metric 类
 *   - records   : { rows:[], schema:{} } 无 meta -- query_records 类
 *   - topology  : { layers:[] } -- query_topology_data 类
 *   - catalog   : [{id,name,...}] -- list_metrics/suggest_metrics 发现类（指标清单）
 *   - raw       : 形状不符 / 非 JSON / 解析失败 -- 原文嵌入，purpose 标注⚠️
 * 这样 Coder 只需按 kind 选渲染路径，不必猜测数据源返回了什么形状。
 */
type NormalizedKind = 'metric' | 'records' | 'topology' | 'catalog' | 'raw'
interface NormalizedResult {
  kind: NormalizedKind
  rows?: unknown[]
  schema?: unknown
  meta?: unknown
  layers?: unknown
  /** catalog 时保留发现的指标/模型清单（[{id,name,description}, ...]） */
  catalog?: unknown[]
  /** raw 时保留原文，方便 Coder 兜底读取 */
  raw?: string
}

function normalizeToolResult(text: string, tool?: string): NormalizedResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { kind: 'raw', raw: text }
  }
  if (data == null || typeof data !== 'object') {
    return { kind: 'raw', raw: text }
  }
  // 发现类工具返回的是数组（指标/模型清单），单独归一成 catalog
  if (Array.isArray(data)) {
    return { kind: 'catalog', catalog: data }
  }
  const obj = data as Record<string, unknown>
  // 含 error 字段 -> 非正常数据形态，降级 raw（不判别 error 具体格式，仅形状判定）
  // 让 Coder 看到⚠️标记 + error 原文，而不是被伪装成空指标/空明细
  if ('error' in obj) return { kind: 'raw', raw: text }
  const rows = Array.isArray(obj.rows) ? obj.rows : undefined
  const schema = obj.schema
  const meta = obj.meta
  const layers = Array.isArray(obj.layers) ? obj.layers : undefined

  // 拓扑优先判定（layers 是强信号，工具名也兜底）
  if (layers || tool === 'query_topology_data') {
    return { kind: 'topology', layers: layers ?? [] }
  }
  // 工具名优先于 meta 判定：
  // query_records 的返回带 meta（model_id/table/record_type，非 default_chart/unit），
  // 纯靠"rows+meta"形状会误判成 metric，必须按工具语义认定为明细。
  if (tool === 'query_records') {
    return { kind: 'records', rows: rows ?? [], schema }
  }
  if (tool === 'query_metric') {
    return { kind: 'metric', rows: rows ?? [], schema, meta }
  }
  // 无工具名线索时，退回形状判定（兼容未知的取数工具）
  if (rows && meta && typeof meta === 'object') return { kind: 'metric', rows, schema, meta }
  if (rows) return { kind: 'records', rows, schema }
  // 兜不住 -> raw
  return { kind: 'raw', raw: text }
}

/**
 * 算归一结果的"行数"用于展示（metric/records=rows.length；topology=各层节点数之和；catalog=清单项数；raw=0）。
 */
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

/**
 * 把一条取数结果（成功路径）转成 DataUseEntry，供版本抽屉展示。
 * status 判定：raw=形状异常降级原文（fallback_raw）；其余=ok。
 */
function toDataUseEntry(
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

/** 取数抛异常时的失败明细（不归一，直接记错误摘要） */
function toFailedEntry(sourceName: string, call: { tool: string; purpose: string }, error: string): DataUseEntry {
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

/** 拼注入 Coder prompt 的数据块：「以下是真实数据」标记 + 归一化 JSON 文本（已剥 URL、分条截断） */
function buildDataBlock(
  results: Array<{ purpose: string; text: string; tool?: string }>
): string {
  const items = results.map((r) => {
    const norm = normalizeToolResult(r.text, r.tool)
    // 非标准结构在用途上标⚠️，提醒 Coder 这条不可信、需走 raw 兜底
    const purpose = norm.kind === 'raw' ? `⚠️非标准结构 ${r.purpose}` : r.purpose
    return { 用途: purpose, kind: norm.kind, 数据: norm }
  })
  // 分条截断：每条单独序列化 + 单独截断，避免一条超大把后面整条挤掉。
  // 每条上限 = 总上限均摊（保底 1KB）；条数多时各条都留得到内容，不丢整条。
  const perItemMax = Math.max(1024, Math.floor(DATA_BLOCK_MAX_BYTES / Math.max(1, items.length)))
  const itemJsons = items.map((it) => {
    const json = stripUrls(JSON.stringify(it, null, 2))
    return truncateBytes(json, perItemMax)
  })
  const body = itemJsons.join(',\n')
  return `以下是从数据源取回的真实数据，已按结构归一，编写页面时必须直接使用其中的数值，不要自己编造：
- 每条数据是一个 JSON 对象，"用途"说明这块数据画什么，"kind"标明数据结构类型，"数据"是归一后的内容。
- kind=metric（指标）：数值在"数据.rows"数组里，每行一个对象，字段名见"数据.schema"；"数据.meta.default_chart"提示画什么图（stat_card 指标卡/gauge 仪表/bar 柱图/line 折线/pie 饼图），"数据.meta.unit"是单位。
- kind=records（明细）：每行一条记录在"数据.rows"里，字段含义见"数据.schema"的 display。
- kind=topology（拓扑）：分层结构在"数据.layers"里，每层 layer.nodes 是该层节点。每个节点的 name 是设备/系统名（必须显示在拓扑节点上，不要编别的名字），status 是状态（normal/warning/critical，决定节点颜色），节点 metrics 数组里的 value 是实时指标值（如在线率99.2%、活跃数156，必须照抄进节点标注，不要换成别的数）。
- kind=catalog（指标清单）：这是发现类结果（list_metrics/suggest_metrics 返回的可用指标列表），不是画图数据。里面的 id 是后续 query_metric 要用的指标标识，name/description 供你理解指标含义；画大屏时不要直接用清单里的内容当数值，需要数值的去找对应 kind=metric 的数据条。
- kind=raw（非标准）：用途带⚠️标记，原文在"数据.raw"里，按需提取，无法识别就改用示例数据并标注。
- 把真实数值直接写进 HTML：metric/records 看"数据.rows"（如 rows[0].avg_cpu_usage=51.4 就在指标卡里写 51.4）；topology 看"数据.layers"的 node.name/node.status/node.metrics[].value（如 layers[0].nodes[0].name="PC终端"、status="normal"、metrics[0].value="99.2%"，就把"PC终端"写在节点上、用正常色、旁边标"99.2%"）。不要换成别的名字或数字。数据里不会出现网址。
[
${body}
]`
}

/**
 * 把上一轮取数的执行记录拼成反馈文本，喂给取数规划 LLM 做纠错轮。
 * 原样保留每条 callTool 的返回文本（含数据源返回的 error+hint），不判别错误--
 * 由 LLM 自己识别 error 并用 available_hints 纠正。截断防 prompt 过长。
 */
function formatAttempts(attempts: Array<{ call: DataFetchCall; result: string }>): string {
  if (attempts.length === 0) return ''
  const lines = attempts.map((a, i) => {
    const argsText = JSON.stringify(a.call.args)
    const resultText = a.result.length > 600 ? `${a.result.slice(0, 600)}…（已截断）` : a.result
    return `第 ${i + 1} 条：工具=${a.call.tool}，参数=${argsText}，用途=${a.call.purpose}\n返回结果：${resultText}`
  })
  return `\n上一轮取数结果（请据此纠正失败项的参数重新规划，全部成功则输出空 calls）：\n${lines.join('\n\n')}`
}

/**
 * 解析 list_metrics / list_models 等发现类工具返回的 JSON，提取 {id, name, description} 列表。
 * 容错：返回可能是数组、也可能是 {items:[...]} / {metrics:[...]} 等包装；非 JSON 返回空。
 * 不认识任何具体业务字段，只认通用的 id/name/description 三件套。
 */
function parseListItems(text: string): Array<{ id: string; name?: string; description?: string }> {
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

/**
 * 截图验收（vision 角色）：成品页面截图 + 参考图（有就带）一起给模型，输出问题清单 JSON。
 * 与 callVisualReview 同输出形态，供检查阶段二选一（截图浏览器可用时用本函数替代文本审查）。
 */
async function callShotReview(
  screenshot: string,
  referenceImage: string | null,
  requirement: string,
  onProgress?: (chars: number, partial: string) => void,
  signal?: AbortSignal
): Promise<ReviewIssue[]> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: prompt('review.shot.user', { requirement: requirement || '（用户只发了图片，没有文字）' }) },
    { type: 'image_url', image_url: { url: screenshot } }
  ]
  if (referenceImage) content.push({ type: 'image_url', image_url: { url: referenceImage } })
  const reply = await gw.chatCompletionStream(
    cachedSettings,
    {
      role: 'vision',
      messages: [
        { role: 'system', content: prompt('review.shot.system') },
        { role: 'user', content }
      ],
      signal
    },
    onProgress ?? (() => {})
  )
  const parsed = gw.extractJson(reply) as { issues?: Array<{ title?: unknown; detail?: unknown }> }
  if (!Array.isArray(parsed.issues)) return []
  return parsed.issues
    .slice(0, 3)
    .map((i) => ({ title: String(i.title ?? '').trim(), detail: String(i.detail ?? '').trim() }))
    .filter((i) => i.title.length > 0)
}

/* ============================== 确定性校验（硬约束的落地） ============================== */
function validateHtml(html: string): string[] {
  const report = artifactRegistry.get('dashboard').validateDraft({
    entryFile: 'index.html',
    files: { 'index.html': html }
  })
  return report.gates
    .filter((gate) => gate.status === 'failed')
    .map((gate) => gate.detail ? `${gate.title}：${gate.detail}` : gate.title)
}

function failActiveStage(rt: Runtime, detail: string): void {
  const stage = rt.s.stages.find(item => item.state === 'active')
  if (!stage) return
  closeOrphanSteps(rt, stage.id, 'failed', detail)
  setStage(rt, { ...stage, state: 'failed', finishedAt: Date.now(), detail })
}

/** 确定性清洗（人工协助修好时用）：剥掉外部资源引用，保证校验能过 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/(<(?:script|link|img|iframe|source)[^>]*?\s)(?:src|href)\s*=\s*["']\s*https?:\/\/[^"']*["']/gi, '$1data-removed-external=""')
    .replace(/url\(\s*["']?\s*https?:\/\/[^)"']*["']?\s*\)/gi, 'url(about:blank)')
}

/** 修复前/后对比截图落盘（shots/<dashId>/<issueId>-before|after.png），失败返回 null 由调用方回落封面占位 */
function persistShot(rt: Runtime, issueId: string, kind: 'before' | 'after', dataUrl: string): string | null {
  try {
    return store.writeShot(rt.s.dashboard.id, `${issueId}-${kind}`, dataUrl)
  } catch {
    return null
  }
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
    // 倒计时到点时大屏可能已被删除、或 option 已失效（用户手动选过 / 状态已变）。
    // 这里是定时器回调，没有 HTTP wrap 兜底，必须自己接住，否则未捕获异常会崩整个进程。
    try {
      handleChooseOption(rt.s.dashboard.id, auto.id, true)
    } catch {
      // 大屏不存在 / option 已失效 -> 静默忽略（autoTimer 已在 handleChooseOption 内清理）
    }
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

/**
 * 取数全部失败 → 数据源卡点卡（datasource_down 场景：★改用演示数据继续 / 再试一次取数 / 呼叫人工）。
 * 分支闭包约定：「改用演示数据」走 run.proceed（调用前把 dataBlock 置 ''）；「再试一次」走 run.retryLlm
 * （dataBlock 保持 undefined，重进 continueCreateToCoding 会重新取数）。两者都回到 continueCreateToCoding。
 */
function raiseDatasourceDownCard(rt: Runtime, run: ActiveRun, stageId: string | null, errSummary: string): void {
  const title = '数据源连不上'
  const description = `取真实数据的时候碰了壁（${truncate(errSummary, 60)}）。可以先用演示数据把大屏做出来，也可以再连一次试试。`
  const options = buildProblemOptions(
    'datasource_down',
    { hasVersion: rt.s.versions.length > 0, lastVersionLabel: rt.s.versions[0]?.label ?? null },
    Date.now()
  )
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
  setBlocker(rt, { id: nextId('blk'), type: 'external', title, description, options, relatedMessageId: msg.id })
  setStatus(rt, 'blocked')
  updateDashboard(rt, { status: 'needs_attention' })
  run.pending.awaiting = 'problem'
  run.proceed = () => void continueCreateToCoding(rt, run)
  run.retryLlm = () => void continueCreateToCoding(rt, run)
  if (stageId) finishStageQuiet(rt, stageId)
  save(rt)
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
  emitPlan(rt, createTitles(hasImage))
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
  const planStep = startStep(rt, 'st-1', hasImage && vision ? '分析你的需求和参考图' : '分析你的需求')
  run.retryLlm = () => void runCreate(rt, run) // 超时卡片的"让 AI 再试一次"也走这里
  const wdPlan = armAgentWatchdog(rt, run, 'st-1', 'other')
  const ctl = new AbortController()
  run.abort = ctl
  try {
    plan = await callPlanner(run.pending.text, run.pending.attachments, vision, llmProgress(rt, 'st-1', '正在分析需求'), ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（超时卡片）
    finishStep(rt, planStep, '没分析完', 'failed')
    raiseLlmFailureCard(rt, run, err, 'st-1')
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdPlan)
  }
  finishStep(rt, planStep, plan.needClarification ? '还有几个细节要跟你确认' : '需求清楚了')
  // 规划结论里的地图备料依据（无图创作用；6 位行政区划代码，否则为空串）
  run.pending.mapAdcode = plan.mapAdcode

  // 参考图精读（带图 + 模型能看图 + 图片裁剪可用时，赶在模板匹配之前）：
  // 裁局部放大图 → 视觉角色读图出内容清单。失败不阻塞：inventory=null，按现有流程继续。
  if (hasImage && vision && run.pending.inventory === undefined) {
    const refImage = run.pending.attachments.find((a) => a.startsWith('data:')) ?? null
    const replicaEnv = await probeReplicaEnv()
    if (refImage && replicaEnv.sharpOk) {
      setStageDetail(rt, 'st-1', '正在精读参考图细节…')
      run.retryLlm = () => void runCreate(rt, run) // 超时卡片的"让 AI 再试一次"也走这里
      const wdInv = armAgentWatchdog(rt, run, 'st-1', 'other')
      const ctlInv = new AbortController()
      run.abort = ctlInv
      let invStep: AgentStep | null = null
      try {
        const size = await imageSize(refImage)
        const regions = referenceRegions(size.width, size.height)
        invStep = startStep(rt, 'st-1', `精读参考图：裁出 ${regions.length} 块局部放大`)
        const crops = await cropImageDataUrl(refImage, regions)
        run.pending.inventory = await callReplicaInventory(refImage, crops, run.pending.text, undefined, ctlInv.signal)
        save(rt)
        finishStep(rt, invStep, `认出了 ${run.pending.inventory.panels.length} 个面板、${run.pending.inventory.kpis.length} 个指标`)
        pushAgent(
          rt,
          `参考图精读完了：${run.pending.inventory.panels.length} 个面板、${run.pending.inventory.kpis.length} 个指标都记下来了，接下来照着做。`
        )
      } catch (err) {
        if (run.watchdogAborted === ctlInv) return // 看门狗已接管（超时卡片）
        if (invStep) finishStep(rt, invStep, '没读全，按看到的大概样子做')
        run.pending.inventory = null
        save(rt)
        pushAgent(rt, '参考图细节没读全，我按看到的大概样子和你的描述来做。')
      } finally {
        if (run.abort === ctlInv) run.abort = null
        disarmAgentWatchdog(rt, run, wdInv)
      }
    } else {
      // 图片裁剪工具不可用（或附件不是图片数据）：不精读，按现有流程继续
      run.pending.inventory = null
      save(rt)
    }
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

/**
 * 「获取数据」阶段：工具目录（listTools 带缓存）→ 取数规划 LLM → 逐个 callTool。
 * 返回 true = 继续编码（dataBlock 快照已写入 run.pending 并落盘）；false = 已发卡片等用户选择。
 * LLM 规划失败走现有 LLM 失败卡；一个源都连不上 / callTool 全部失败走 datasource_down 卡点卡。
 */
async function fetchDataForCreate(rt: Runtime, run: ActiveRun, stageId: string): Promise<boolean> {
  const sources = cachedDataSources.filter((s) => s.enabled && s.url)

  // 1) 组装工具目录（工具名 + 参数 schema + 大白话用途）；连不上的源记下来，不进白名单
  const catalogLines: string[] = []
  const whitelist = new Map<string, Set<string>>()
  const sourceById = new Map<string, McpDataSource>()
  const listErrors: string[] = []
  for (const s of sources) {
    sourceById.set(s.id, s)
    try {
      const tools = await mcpListTools(s)
      whitelist.set(s.id, new Set(tools.map((t) => t.name)))
      catalogLines.push(`数据源「${s.name || s.url}」（sourceId：${s.id}），可用工具：`)
      for (const t of tools) {
        const schemaText = t.inputSchema ? truncate(JSON.stringify(t.inputSchema), 300) : ''
        catalogLines.push(`- ${t.name}${t.description ? `：${t.description}` : ''}${schemaText ? `（参数：${schemaText}）` : ''}`)
      }
    } catch (err) {
      listErrors.push(err instanceof McpError ? `「${s.name || s.url}」${err.message}` : `「${s.name || s.url}」连不上`)
    }
  }

  // 1.5) 主动预取指标与模型清单，拼进工具目录，让 LLM 直接看到具体 id 去 query 取数，
  // 不必浪费规划额度自己调 list_metrics/list_models 发现。预取失败不阻塞（LLM 仍可自己发现）。
  // 调的是数据源自己暴露的发现类工具（动态），不是硬编码任何指标名。
  setStageDetail(rt, stageId, '正在浏览数据源有哪些指标和数据表…')
  for (const s of sources) {
    const tools = whitelist.get(s.id)
    if (!tools) continue
    const previewLines: string[] = []
    // 指标清单（list_metrics）
    if (tools.has('list_metrics')) {
      try {
        const text = await mcpCallTool(s, 'list_metrics', {})
        const items = parseListItems(text)
        if (items.length > 0) {
          previewLines.push(`该数据源已注册的指标（直接用 id 调 query_metric 取数，不必再调 list_metrics）：`)
          for (const it of items.slice(0, 20)) {
            previewLines.push(`  - 指标 id="${it.id}"${it.name ? `（${it.name}）` : ''}${it.description ? `：${it.description}` : ''}`)
          }
          if (items.length > 20) previewLines.push(`  …共 ${items.length} 个，已列前 20 个`)
        }
      } catch { /* 预取失败不阻塞 */ }
    }
    // 数据模型清单（list_models，供 query_records 用）
    if (tools.has('list_models')) {
      try {
        const text = await mcpCallTool(s, 'list_models', {})
        const items = parseListItems(text)
        if (items.length > 0) {
          previewLines.push(`该数据源可查明细的数据模型（直接用 id 调 query_records 取明细）：`)
          for (const it of items.slice(0, 15)) {
            previewLines.push(`  - 模型 id="${it.id}"${it.description ? `：${it.description}` : ''}`)
          }
          if (items.length > 15) previewLines.push(`  …共 ${items.length} 个，已列前 15 个`)
        }
      } catch { /* 预取失败不阻塞 */ }
    }
    if (previewLines.length > 0) catalogLines.push(previewLines.join('\n'))
  }
  if (whitelist.size === 0) {
    raiseDatasourceDownCard(rt, run, stageId, listErrors.join('；') || '配置的数据源都连不上')
    return false
  }
  if (listErrors.length > 0) {
    pushAgent(rt, `有数据源暂时连不上（${listErrors.join('；')}），我先看看剩下的能不能满足需求。`)
  }

  // 2) 取数规划（planner 角色，看门狗按 'other' 布防；LLM 失败走现有 LLM 失败卡）
  setStageDetail(rt, stageId, '正在规划要取哪些数据…')
  const planFetchStep = startStep(rt, stageId, '规划要取哪些数据')
  let calls: DataFetchCall[]
  run.retryLlm = () => void continueCreateToCoding(rt, run) // 失败/超时卡片的"让 AI 再试一次"也走这里
  const wdPlan = armAgentWatchdog(rt, run, stageId, 'other')
  const ctl = new AbortController()
  run.abort = ctl
  try {
    const raw = await callDataFetchPlan(
      run.pending.text,
      run.pending.answersSummary,
      catalogLines.join('\n'),
      llmProgress(rt, stageId, '正在规划取数'),
      ctl.signal
    )
    calls = normalizeDataFetchCalls(raw, whitelist)
  } catch (err) {
    if (run.watchdogAborted === ctl) return false // 看门狗已接管（超时卡片）
    finishStep(rt, planFetchStep, '没规划完', 'failed')
    raiseLlmFailureCard(rt, run, err, stageId)
    return false
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdPlan)
  }
  finishStep(rt, planFetchStep, calls.length > 0 ? `要取 ${calls.length} 批数据` : '这版用演示数据就够用')

  // 3) 规划结论：不需要真实数据 → 用演示数据（快照记 ''，后续环节不再重取）
  if (calls.length === 0) {
    pushAgent(rt, '看了下需求，这版用演示数据就够用，不额外连数据源取数了。')
    run.pending.dataBlock = ''
    rt.s.lastDataBlock = ''
    run.pending.dataSourcesUsed = [] // 演示数据 = 无数据源
    rt.s.lastDataSourcesUsed = []
    save(rt)
    return true
  }

  // 4) 逐个执行取数调用（单个失败不致命，记下来继续；callTool 自带 15 秒超时 + 重试 1 次）
  //    闭环：首轮规划执行后，若有失败，把执行结果（含数据源返回的错误+hint）反馈给取数规划 LLM，
  //    让它基于 hint 纠正参数重新规划，最多再试 1 轮。判别"是不是失败"不靠代码硬编码错误格式，
  //    而是把每条 callTool 的原始返回原样喂给 LLM，由 LLM 自己识别 error 并用 available_hints 纠正。
  const results: Array<{ purpose: string; text: string; tool?: string }> = []
  const callErrors: string[] = []
  /**
   * 取数明细累积（按 call 签名去重，纠错轮重试同一条时覆盖前一轮的记录，保留最终结果）。
   * commitVersion 时落盘 + 塞进 Version.dataSourcesUsed。
   */
  const usedMap = new Map<string, DataUseEntry>()
  /** call 签名：同一 source+tool+purpose 视为同一条（purpose 由 LLM 生成，相同意图复述应一致） */
  const sigOf = (c: DataFetchCall) => `${c.sourceId}|${c.tool}|${c.purpose || ''}`
  /** 本轮每条调用的原文记录，用于反馈给规划 LLM（call + 返回文本，不判别错误） */
  let attemptsLog: Array<{ call: DataFetchCall; result: string }> = []
  const MAX_ROUNDS = 2
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) {
      // 纠错轮：把上一轮执行结果反馈给规划 LLM，让它输出需要重试的 calls
      setStageDetail(rt, stageId, round === 1 ? '有些数据没取到，正在按数据源的提示重新取…' : '再次尝试取数…')
      const retryStep = startStep(rt, stageId, round === 1 ? '按提示纠正后重新取数' : `第 ${round + 1} 轮取数`)
      const wdRetry = armAgentWatchdog(rt, run, stageId, 'other')
      const ctlRetry = new AbortController()
      run.abort = ctlRetry
      let retryCalls: DataFetchCall[] = []
      try {
        const raw = await callDataFetchPlan(
          run.pending.text,
          run.pending.answersSummary,
          catalogLines.join('\n'),
          llmProgress(rt, stageId, '正在规划重新取数'),
          ctlRetry.signal,
          formatAttempts(attemptsLog)
        )
        retryCalls = normalizeDataFetchCalls(raw, whitelist)
      } catch (err) {
        if (run.watchdogAborted === ctlRetry) return false
        finishStep(rt, retryStep, '没规划完，用已有的继续', 'failed')
      } finally {
        if (run.abort === ctlRetry) run.abort = null
        disarmAgentWatchdog(rt, run, wdRetry)
      }
      if (retryCalls.length === 0) {
        finishStep(rt, retryStep, '没有需要重试的了')
        break // LLM 说不用再试（都成功或无纠正线索），结束闭环
      }
      finishStep(rt, retryStep, `要重新取 ${retryCalls.length} 批`)
      calls = retryCalls
      attemptsLog = [] // 新一轮重新记录
    }

    for (const [i, call] of calls.entries()) {
      const source = sourceById.get(call.sourceId) as McpDataSource
      const sourceName = source?.name || source?.url || call.sourceId
      setStageDetail(rt, stageId, `正在取数 ${i + 1}/${calls.length}：${call.purpose || call.tool}…`)
      const fetchStep = startStep(rt, stageId, `取数 ${i + 1}/${calls.length}：${call.purpose || call.tool}`)
      try {
        const text = await mcpCallTool(source, call.tool, call.args)
        attemptsLog.push({ call, result: text })
        results.push({ purpose: call.purpose || call.tool, text, tool: call.tool })
        // 捕获取数明细（成功路径：归一后判 status，raw=降级）
        usedMap.set(sigOf(call), toDataUseEntry(sourceName, call, normalizeToolResult(text, call.tool)))
        finishStep(rt, fetchStep, '拿到了')
      } catch (err) {
        const msg = err instanceof McpError ? err.message : `取「${call.purpose || call.tool}」失败了`
        callErrors.push(msg)
        attemptsLog.push({ call, result: msg })
        // 捕获取数明细（失败路径：记错误摘要）
        usedMap.set(sigOf(call), toFailedEntry(sourceName, call, msg))
        finishStep(rt, fetchStep, '没取到')
      }
    }

    // 首轮执行后判断要不要进纠错轮。
    // 不靠 callErrors（业务错误 HTTP 200 不会抛异常，callErrors 捕获不到），
    // 而是看本轮返回里有没有"值得让 LLM 再看一眼"的迹象--启发式（不判别具体格式），
    // 只用于决定"要不要打扰 LLM"，权威判断交给 LLM 自己读 attemptsLog。
    // 触发条件：含 error 字样（取数报错）、或返回空数组 [] / 空对象（发现不到东西）。
    if (round === 0) {
      const needsRetry = attemptsLog.some((a) => {
        const head = a.result.slice(0, 800)
        return /"error"\s*:/.test(head) || /\[\s*\]/.test(head) || /^\s*\{\s*\}\s*$/.test(a.result.trim())
      })
      if (!needsRetry) break // 都成功且非空，不必进纠错轮
    }
    // 纠错轮后不再继续（已用尽 MAX_ROUNDS）
  }

  // 5) 全部失败 → 数据源卡点卡等用户选
  if (results.length === 0) {
    raiseDatasourceDownCard(rt, run, stageId, callErrors.join('；') || '数据源没有返回数据')
    return false
  }

  // 6) 拼数据块（剥 URL + 8KB 截断 + 「以下是真实数据」标记），存快照并落盘
  if (callErrors.length > 0) pushAgent(rt, `有部分数据没取到（${callErrors.join('；')}），先用取到的这些。`)
  const block = buildDataBlock(results)
  run.pending.dataBlock = block
  rt.s.lastDataBlock = block
  run.pending.dataSourcesUsed = [...usedMap.values()]
  rt.s.lastDataSourcesUsed = run.pending.dataSourcesUsed
  save(rt)
  pushAgent(rt, `真实数据取到了（${results.map((r) => `「${truncate(r.purpose, 12)}」`).join('、')}），编写页面时直接用这些真数据。`)
  return true
}

/** 澄清之后（或无需澄清）：匹配模板 → 获取数据（有启用数据源时）→ 编写页面 → 视觉检查 → 修复问题 → 生成预览 */
async function continueCreateToCoding(rt: Runtime, run: ActiveRun): Promise<void> {
  rt.running = true
  setStatus(rt, 'generating')
  const ids = createStageIds()
  activateStage(rt, 'st-2')

  // 阶段 2：匹配模板（模板库存在且本轮还没匹配过时）
  if (templatesRoot && !run.pending.template) {
    const cnt = catalogCount()
    setStageDetail(rt, 'st-2', `正在和模板库比对：${cnt.layouts} 种布局、${cnt.components} 类组件…`)
    const matchStep = startStep(rt, 'st-2', `和模板库比对：${cnt.layouts} 种布局、${cnt.components} 类组件`)
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

    const hasHit = match && (match.layoutId !== null || match.modules.some((m) => m.templateId))
    if (hasHit && match) {
      // 有命中（含部分命中）：继续，未覆盖部分自定义
      run.pending.template = {
        layoutId: match.layoutId,
        modules: match.modules,
        useTemplate: true
      }
      const layoutName = match.layoutId ? findTemplate(match.layoutId)?.name : undefined
      const moduleRoles = match.modules
        .filter((m) => m.templateId)
        .map((m) => `「${m.role}」`)
        .join('、')
      finishStep(rt, matchStep, `命中${layoutName ? `「${layoutName}」` : ''}${moduleRoles ? `、${moduleRoles}` : ''}`)
      pushAgent(
        rt,
        `模板匹配好了：${layoutName ? `布局用「${layoutName}」` : ''}${moduleRoles ? `，模块匹配到 ${moduleRoles}` : ''}，这些都会照着模板库的标准样式来做，还原度更高。` +
          (match.unmatched.length > 0 ? `另外「${match.unmatched.join('、')}」模板库里没有，这部分我按需求自定义。` : '')
      )
      finishStage(rt, 'st-2')
    } else {
      // 完全没匹配上：让用户确认是否自定义生成（UX：必选项 + 必推荐）
      finishStep(rt, matchStep, '没有命中，按你的需求自定义做')
      run.pending.template = { layoutId: null, modules: [], useTemplate: false }
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

  // 阶段 3（有启用数据源时）：获取数据。已有快照（重试/续跑/用户选过演示数据）直接复用，不重新取数
  if (ids.fetch) {
    activateStage(rt, ids.fetch)
    if (run.pending.dataBlock === undefined) {
      const fetched = await fetchDataForCreate(rt, run, ids.fetch)
      if (!fetched) {
        rt.running = false
        return
      }
    } else {
      setStageDetail(rt, ids.fetch, '沿用上次取数的结果…')
      await sleep(400)
    }
    finishStage(rt, ids.fetch)
  }

  activateStage(rt, ids.code)

  // 备料：地图 SVG 路径（有图无图都可能触发——精读清单或规划结论给了行政区划代码时才去取）。
  // 取图/投影任何一步失败都不阻塞：pushAgent 一句大白话，Coder 按需求描述来画。
  if (run.pending.mapPaths === undefined) {
    const adcode =
      run.pending.inventory?.hasMap && run.pending.inventory.mapAdcode
        ? run.pending.inventory.mapAdcode
        : (run.pending.mapAdcode ?? '')
    if (adcode) {
      setStageDetail(rt, ids.code, '正在准备地图素材…')
      const mapStep = startStep(rt, ids.code, '准备地图素材：下载真实地图，转成页面能直接用的图形')
      try {
        const geojson = await fetchGeoJson(adcode)
        run.pending.mapPaths = geojsonToSvgPaths(geojson, 640, 520, 2)
        finishStep(rt, mapStep, '地图素材准备好了')
      } catch {
        run.pending.mapPaths = null
        finishStep(rt, mapStep, '没准备好，按需求描述来画')
        pushAgent(rt, '地图素材没准备好，我按需求描述来画。')
      }
      save(rt)
    } else {
      run.pending.mapPaths = null
    }
  }

  // 首次创建（没有任何旧版本）时：边生成边把部分 HTML 推到预览区，页面逐步长出来
  const livePreview = rt.s.versions.length === 0 ? makeLivePreview(rt) : null
  const progress = llmProgress(rt, ids.code, '正在编写页面')
  const capForVision = await getCapability()
  const visionOk = capForVision.ok && capForVision.supportsVision
  // 有精读清单 → Coder 走复刻 prompt（参考图仅在模型能看图时带上）
  const replica: ReplicaContext | null = run.pending.inventory
    ? {
        inventory: run.pending.inventory,
        referenceImage: visionOk ? (run.pending.attachments.find((a) => a.startsWith('data:')) ?? null) : null,
        mapPaths: run.pending.mapPaths ?? null
      }
    : null
  let html: string
  const codeStep = startStep(rt, ids.code, replica ? '照着参考图编写页面' : '编写页面')
  const wdCode = armAgentWatchdog(rt, run, ids.code, 'coding', { check: ids.check, repair: ids.repair, finish: ids.finish })
  const ctl = new AbortController()
  run.abort = ctl
  try {
    html = await callCoderCreate(run.pending.text, run.pending.answersSummary, run.pending.template, visionOk, run.pending.dataBlock ?? '', replica, run.pending.mapPaths ?? null, (chars, partial) => {
      progress(chars)
      livePreview?.(partial)
    }, ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（自动拆分步骤）
    finishStep(rt, codeStep, '页面没写完', 'failed')
    raiseLlmFailureCard(rt, run, err, ids.code)
    run.retryLlm = () => void continueCreateToCoding(rt, run)
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdCode)
  }
  finishStep(rt, codeStep, `写完了，共 ${html.length.toLocaleString('zh-CN')} 字`)
  run.html = html
  finishStage(rt, ids.code)

  await checkRepairAndFinish(rt, run, ids.check, ids.repair, ids.finish)
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

  // 视觉检查 = 确定性硬校验 + LLM 审查（审查失败不阻塞，硬校验兜底；LLM 调用布防看门狗，卡死出超时卡片）。
  // 截图浏览器可用且模型能看图时，用真截图对比验收（有参考图带上参考图）替代文本审查；
  // 截图或审查任何一环失败 → 回落文本审查，行为与原来一致。
  setStageDetail(rt, checkStageId, '先做硬性规则检查：页面完整性、是否引用外部素材…')
  const hardStep = startStep(rt, checkStageId, '硬性规则检查：页面完整性、有没有引用外部素材')
  let hard = validateHtml(run.html)
  finishStep(rt, hardStep, hard.length > 0 ? `发现 ${hard.length} 处问题` : '通过')
  const capForShot = await getCapability()
  const visionForShot = capForShot.ok && capForShot.supportsVision
  const replicaEnv = await probeReplicaEnv()
  const shotEnvOk = replicaEnv.ok && visionForShot
  const referenceImage = visionForShot ? (run.pending.attachments.find((a) => a.startsWith('data:')) ?? null) : null
  let review: ReviewIssue[] = []
  let usedShotReview = false
  let shotDataUrl: string | null = null // 修复前真截图（截图验收路径专用，落盘为 Issue.beforeShotUrl）
  run.retryLlm = () => void checkRepairAndFinish(rt, run, checkStageId, repairStageId, finishStageId)
  const wdReview = armAgentWatchdog(rt, run, checkStageId, 'other')
  const ctlReview = new AbortController()
  run.abort = ctlReview
  try {
    let shotPathStep: AgentStep | null = null
    try {
      if (shotEnvOk) {
        setStageDetail(rt, checkStageId, '正在给页面截图，照着要求对比检查…')
        shotPathStep = startStep(rt, checkStageId, '给页面截图')
        shotDataUrl = await renderShotDataUrl(run.html, 1920, 1080)
        finishStep(rt, shotPathStep, '截图好了')
        shotPathStep = startStep(rt, checkStageId, referenceImage ? '拿着截图和参考图对比检查' : '拿着截图逐项检查')
        review = await callShotReview(shotDataUrl, referenceImage, run.pending.text, llmProgress(rt, checkStageId, '正在对比检查'), ctlReview.signal)
        usedShotReview = true
        finishStep(rt, shotPathStep, review.length > 0 ? `发现 ${review.length} 个问题` : '没发现问题')
        shotPathStep = null
      }
    } catch (err) {
      if (run.watchdogAborted === ctlReview) return // 看门狗已接管（超时卡片）
      if (shotPathStep) finishStep(rt, shotPathStep, '没完成，改用文字检查')
      review = []
      shotDataUrl = null
    }
    if (!usedShotReview) {
      // 文本审查兜底（无截图浏览器 / 模型看不了图 / 截图路径失败）
      const textReviewStep = startStep(rt, checkStageId, '检查页面源码布局')
      try {
        review = await callVisualReview(run.html, run.pending.text, llmProgress(rt, checkStageId, '正在审查布局'), ctlReview.signal)
        finishStep(rt, textReviewStep, review.length > 0 ? `发现 ${review.length} 个问题` : '没发现问题')
      } catch (err) {
        if (run.watchdogAborted === ctlReview) return // 看门狗已接管（超时卡片）
        finishStep(rt, textReviewStep, '审查没完成，用硬性检查结果兜底')
        review = []
      }
    }
  } finally {
    if (run.abort === ctlReview) run.abort = null
    disarmAgentWatchdog(rt, run, wdReview)
  }
  // 硬校验 + 审查问题合并去重
  let problems = [...hard]
  for (const r of review) if (!problems.includes(r.title)) problems.push(r.title)
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
  const issues: Issue[] = problems.slice(0, 3).map((p, i) => {
    const id = i === 0 ? (run.pending.issueId ?? nextId('issue')) : nextId('issue')
    return {
      id,
      stageId: fixStageId,
      title: p,
      attempt: 1,
      status: 'fixing' as const,
      // 截图验收路径：修复前真截图落盘；文本审查兜底路径维持封面占位
      beforeShotUrl: shotDataUrl
        ? (persistShot(rt, id, 'before', shotDataUrl) ?? (rt.s.dashboard.coverUrl || null))
        : rt.s.dashboard.coverUrl || null,
      afterShotUrl: null,
      detail: details.get(p) ?? ''
    }
  })
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
    const fixStep = startStep(rt, fixStageId, `修复 ${problems.length} 个问题（第 ${issues[0].attempt} 次）`)
    const wdFix = armAgentWatchdog(rt, run, fixStageId, 'other')
    const ctlFix = new AbortController()
    run.abort = ctlFix
    try {
      run.html = await callCoderRepair(run.html, problems, run.pending.dataBlock ?? '', llmProgress(rt, fixStageId, '正在修复问题'), ctlFix.signal)
    } catch (err) {
      if (run.watchdogAborted === ctlFix) return // 看门狗已接管（超时卡片）
      finishStep(rt, fixStep, '修复没完成', 'failed')
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
    // 截图验收路径：修完重新截图复审一轮（截图/复审失败不阻塞，回落到只看硬校验）
    let afterShot: string | null = null
    let recheck: ReviewIssue[] = []
    if (usedShotReview) {
      const wdRe = armAgentWatchdog(rt, run, fixStageId, 'other')
      const ctlRe = new AbortController()
      run.abort = ctlRe
      try {
        setStageDetail(rt, fixStageId, '正在重新截图，复查修复效果…')
        afterShot = await renderShotDataUrl(run.html, 1920, 1080)
        recheck = await callShotReview(afterShot, referenceImage, run.pending.text, llmProgress(rt, fixStageId, '正在复查修复效果'), ctlRe.signal)
      } catch (err) {
        if (run.watchdogAborted === ctlRe) return // 看门狗已接管（超时卡片）
        recheck = []
        afterShot = null
      } finally {
        if (run.abort === ctlRe) run.abort = null
        disarmAgentWatchdog(rt, run, wdRe)
      }
    }
    const remaining = [...hard]
    for (const r of recheck) if (!remaining.includes(r.title)) remaining.push(r.title)
    if (remaining.length === 0) {
      finishStep(rt, fixStep, '修好了，复查通过')
      issues.forEach((i) =>
        setIssue(rt, {
          ...i,
          status: 'fixed',
          // 截图验收路径：修复后真截图落盘；文本审查兜底路径维持封面占位
          afterShotUrl: afterShot
            ? (persistShot(rt, i.id, 'after', afterShot) ?? (rt.s.dashboard.coverUrl || null))
            : rt.s.dashboard.coverUrl || null,
          detail: 'AI 已重新生成并通过检查。'
        })
      )
      finishStage(rt, fixStageId)
      await finishRunCommit(rt, run, finishStageId)
      return
    }
    problems = remaining
    finishStep(rt, fixStep, `还剩 ${remaining.length} 个问题没修好`)
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
    const retryStep = startStep(rt, checkStageId, `再修一次（第 ${next.attempt} 次）：${problems[0]}`)
    run.retryLlm = () => void resumeRepair(rt, run, checkStageId, finishStageId)
    const wdFix = armAgentWatchdog(rt, run, checkStageId, 'other')
    const ctlFix = new AbortController()
    run.abort = ctlFix
    try {
      run.html = await callCoderRepair(run.html, problems, run.pending.dataBlock ?? '', llmProgress(rt, checkStageId, '正在修复问题'), ctlFix.signal)
    } catch (err) {
      if (run.watchdogAborted === ctlFix) return // 看门狗已接管（超时卡片）
      finishStep(rt, retryStep, '修复没完成', 'failed')
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
      finishStep(rt, retryStep, '修好了，复查通过')
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
    finishStep(rt, retryStep, '还是没修好', 'failed')
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
  const commitStep = startStep(rt, finishStageId, '生成预览，存成新版本')
  await sleep(600)
  commitVersion(rt, run)
  finishStep(rt, commitStep, '新版本可以看了')
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
  // 数据来源明细落盘（与 index.html 同目录的 data-used.json；演示数据/无数据源时为空数组也写一份）
  const dataSourcesUsed = run.pending.dataSourcesUsed ?? []
  if (dataSourcesUsed.length > 0) {
    store.writeVersionMeta(dashId, id, dataSourcesUsed)
  }
  const url = artifactPreviewUrl(dashId, id)
  const v: Version = {
    id,
    label: `v${n}`,
    summary: run.pending.kind === 'create' ? '初版完成' : truncate(run.pending.text) || '修改',
    createdAt: Date.now(),
    screenshotUrl: rt.s.dashboard.coverUrl || coverFor(run.pending.text),
    published: false,
    isCurrent: true,
    dataSourcesUsed: dataSourcesUsed.length > 0 ? dataSourcesUsed : undefined,
    manifest: manifestFor(rt.s.dashboard.artifactKind),
    validationReport: artifactRegistry.get('dashboard').validateDraft({
      entryFile: 'index.html',
      files: { 'index.html': run.html }
    })
  }
  addVersion(rt, v, url)
  previewReady(rt, id, url)
}

/** 无参考图时展示的业务应用七阶段执行计划。 */
const BUSINESS_APP_STAGE_TITLES = [
  '收敛业务需求契约',
  '规划应用模块与业务流程',
  '查询 IDux 组件证据',
  '生成并构建业务应用',
  '验收准确性、体验与安全',
  '自动诊断、修复并复检',
  '生成可交付版本'
]

/** 有参考图时展示的业务应用七阶段执行计划。 */
const BUSINESS_APP_IMAGE_STAGE_TITLES = [
  '收敛业务需求契约',
  '分析参考图并规划应用',
  '映射 IDux 组件与样式',
  '生成并构建业务应用',
  '验收流程、参考图与双视口',
  '自动诊断、修复并复检',
  '生成可交付版本'
]

/**
 * business-app 声明式 Loop 拓扑。
 *
 * 需求节点可挂起等待单问题回答；构建或验收失败统一进入修复节点，只有全部门禁通过才能到达 finish。
 */
const BUSINESS_APP_FLOW: FlowDefinition = {
  nodes: [
    { id: 'requirements', name: '收敛需求契约' },
    { id: 'planner', name: '规划业务应用' },
    { id: 'coder', name: '生成并构建业务应用' },
    { id: 'check', name: '浏览器质量验收' },
    { id: 'repair', name: '自动修复' },
    { id: 'finish', name: '闭环交付' }
  ],
  edges: [
    { from: 'requirements', to: 'planner' },
    { from: 'planner', to: 'coder' },
    { from: 'coder', to: 'check', guard: 'buildPassed' },
    { from: 'coder', to: 'repair' },
    { from: 'check', to: 'finish', guard: 'qualityPassed' },
    { from: 'check', to: 'repair' },
    { from: 'repair', to: 'coder' }
  ],
  guards: {
    buildPassed: (gs) => gs.nodes.coder?.output?.passed === true,
    qualityPassed: (gs) => gs.nodes.check?.output?.passed === true
  }
}

/** 将 LoopEngine 图状态转换成工作台可展示、可落盘的精简快照。 */
function businessAppGraphSnapshot(gs: GraphState): GraphSnapshot {
  const finished = !gs.awaiting && gs.nodes.finish?.status === 'done'
  return {
    nodes: gs.definition.nodes.map(node => {
      const state = gs.nodes[node.id]
      const summary: Record<string, string | number | boolean | null> = {}
      const output = state?.output
      for (const key of ['passed', 'issueCount', 'attempt', 'iduxVersion', 'repairCount']) {
        const value = output?.[key]
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          summary[key] = value
        }
      }
      const status = state?.status ?? 'pending'
      return {
        id: node.id,
        name: node.name,
        status: finished && status === 'pending' ? 'skipped' : status,
        summary
      }
    }),
    edges: gs.definition.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      guard: edge.guard
    })),
    current: gs.current,
    awaiting: gs.awaiting
  }
}

/** 持久化并广播业务应用流程图状态。 */
function emitBusinessAppGraph(rt: Runtime, graph: GraphSnapshot): void {
  rt.s.graph = graph
  store.emit(rt.s.dashboard.id, 'graph', { dashboardId: rt.s.dashboard.id, graph })
  save(rt)
}

/** 在执行器启动前发送完整图骨架，避免界面阶段信息延迟出现。 */
function emitBusinessAppGraphSkeleton(rt: Runtime): void {
  emitBusinessAppGraph(rt, {
    nodes: BUSINESS_APP_FLOW.nodes.map(node => ({
      id: node.id,
      name: node.name,
      status: node.id === 'requirements' ? 'active' : 'pending',
      summary: {}
    })),
    edges: BUSINESS_APP_FLOW.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      guard: edge.guard
    })),
    current: 'requirements',
    awaiting: null
  })
}

/** 不创建新需求、而是继续当前失败候选的用户短语。 */
const BUSINESS_APP_CONTINUE_REQUEST = /^(?:继续|重试|再试(?:一次)?|继续修复|接着修|恢复)(?:吧|一下|看看|检查)?[。！!]?$/i

/** 获取并补齐旧会话中可能缺少字段的 business-app 状态。 */
function getBusinessAppState(rt: Runtime): BusinessAppProjectState {
  rt.s.businessAppState ??= {
    requirements: [],
    activeRequirement: null,
    candidateRevisionId: null,
    unresolved: false,
    strategiesTried: [],
    lastFailure: null,
    decisions: [],
    requirementContract: null,
    blueprint: null,
    changePlan: null,
    candidateBlueprint: null,
    candidateChangePlan: null,
    pendingClarification: null,
    checkpoint: null
  }
  rt.s.businessAppState.decisions ??= []
  rt.s.businessAppState.requirementContract ??= null
  rt.s.businessAppState.blueprint ??= null
  rt.s.businessAppState.changePlan ??= null
  rt.s.businessAppState.candidateBlueprint ??= null
  rt.s.businessAppState.candidateChangePlan ??= null
  rt.s.businessAppState.pendingClarification ??= null
  rt.s.businessAppState.checkpoint ??= null
  return rt.s.businessAppState
}

/** 解析新需求或续跑指令，并记录当前轮唯一有效的需求文本。 */
function effectiveBusinessAppRequest(rt: Runtime, request: string): string {
  const state = getBusinessAppState(rt)
  const current = request.trim()
  const resume = BUSINESS_APP_CONTINUE_REQUEST.test(current) && state.unresolved
  if (!resume && current.length > 0) {
    const requirement = truncate(current, 500)
    if (!state.requirements.includes(requirement)) state.requirements.push(requirement)
    state.requirements = state.requirements.slice(-20)
    state.activeRequirement = requirement
  }
  if (!state.activeRequirement && state.requirements.length > 0) {
    state.activeRequirement = state.requirements[state.requirements.length - 1]
  }
  state.unresolved = true
  save(rt)
  return state.activeRequirement || current || '继续完成当前业务应用目标'
}

/** 将领域层的单问题澄清契约转换成工作台消息和阻断卡片。 */
function emitBusinessAppClarification(
  rt: Runtime,
  clarification: BusinessAppClarificationTurn
): void {
  const question: ClarificationQuestion = {
    id: clarification.topic,
    question: clarification.question,
    options: clarification.options.map(option => ({
      id: option.id,
      title: option.title,
      consequence: option.consequence,
      recommended: option.recommended,
      recommendReason: option.recommendReason,
      riskLevel: option.riskLevel,
      autoExecuteAt: null
    })),
    allowCustomInput: clarification.allowCustomInput,
    answer: null
  }
  const card: ClarificationMessage = {
    kind: 'clarification',
    id: nextId('m'),
    createdAt: Date.now(),
    intro: clarification.intro,
    questions: [question],
    answered: false
  }
  pushMessage(rt, card)
  setStatus(rt, 'awaiting_clarification')
  setBlocker(rt, {
    id: nextId('blk'),
    type: 'clarification',
    title: '需要确认一个关键问题',
    description: '本轮只确认这一项；回答后会继续判断是否还有下一个阻断问题。',
    options: [{
      id: 'opt-goto-answer',
      title: '去回答',
      consequence: '跳到对话中的单问题澄清卡片',
      recommended: true,
      recommendReason: '确认关键边界后再生成，避免做出错误业务流程',
      riskLevel: 'low',
      autoExecuteAt: null
    }],
    relatedMessageId: card.id
  })
  save(rt)
}

/** 将内部异常转换为不泄漏本地路径、长度受限的用户可见错误。 */
function safeBusinessAppError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/Executable doesn't exist|playwright install/i.test(raw)) {
    return '浏览器验收环境不可用：请安装 Chromium、Chrome 或 Edge'
  }
  return raw
    .replace(/[A-Za-z]:\\[^\r\n]+/g, '[本地路径]')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

/** 把失败门禁整理为包含期望、实际、复现与验收条件的修复契约。 */
function iduxFailureContract(gates: ValidationGateResult[]): string {
  return gates.slice(0, 4).map(gate =>
    `【${gate.id}】期望：${gate.title}；实际：${gate.detail ?? '门禁未通过'}；复现：按该门禁对应的双视口任务场景执行；验收：复检状态必须为 passed。`
  ).join('\n')
}

/** 按图片实际尺寸生成参考图精读区域，并保证所有区域不越界。 */
function businessAppReferenceRegions(width: number, height: number): Region[] {
  const clamp = (left: number, top: number, regionWidth: number, regionHeight: number): Region => {
    const safeLeft = Math.min(Math.max(0, Math.round(left)), width - 1)
    const safeTop = Math.min(Math.max(0, Math.round(top)), height - 1)
    return {
      left: safeLeft,
      top: safeTop,
      width: Math.max(1, Math.min(Math.round(regionWidth), width - safeLeft)),
      height: Math.max(1, Math.min(Math.round(regionHeight), height - safeTop))
    }
  }
  return [
    clamp(0, 0, width, height * 0.3),
    clamp(0, height * 0.25, width * 0.6, height * 0.5),
    clamp(width * 0.55, height * 0.25, width * 0.45, height * 0.5),
    clamp(0, height * 0.7, width, height * 0.3)
  ]
}

/**
 * 执行完整 business-app Loop。
 *
 * 流程覆盖逐问澄清、参考图分析、增量规划、受控构建、双视口场景验收、策略化修复和原子提交。
 * 未通过全部门禁的候选只保留在工作状态中，不会污染已提交版本。
 */
async function runBusinessAppGeneration(
  rt: Runtime,
  request: string,
  attachments: string[]
): Promise<void> {
  if (rt.running) return
  rt.running = true
  setStatus(rt, 'generating')
  updateDashboard(rt, { status: 'generating' })
  emitPlan(rt, attachments.length > 0 ? BUSINESS_APP_IMAGE_STAGE_TITLES : BUSINESS_APP_STAGE_TITLES)
  emitBusinessAppGraphSkeleton(rt)

  const businessAppState = getBusinessAppState(rt)
  const resumeCandidate = BUSINESS_APP_CONTINUE_REQUEST.test(request.trim()) && businessAppState.unresolved
  if (!resumeCandidate) {
    businessAppState.decisions = []
    businessAppState.requirementContract = null
    businessAppState.pendingClarification = null
    businessAppState.checkpoint = null
    businessAppState.candidateBlueprint = null
    businessAppState.candidateChangePlan = null
  }
  const baseRevisionId = resumeCandidate
    ? businessAppState.candidateRevisionId
    : rt.s.dashboard.currentRevisionId
  const baseDraft = baseRevisionId
    ? store.readArtifactDraft(rt.s.dashboard.id, baseRevisionId)
    : null
  const requirement = effectiveBusinessAppRequest(rt, request)
  const revisionId = resumeCandidate && businessAppState.candidateRevisionId
    ? businessAppState.candidateRevisionId
    : nextId('ver')
  businessAppState.candidateRevisionId = revisionId
  if (!resumeCandidate) businessAppState.strategiesTried = []
  businessAppState.lastFailure = null
  save(rt)
  const workspace = store.artifactWorkspaceDir(rt.s.dashboard.id, revisionId)
  const outputDir = store.previewDir(rt.s.dashboard.id, revisionId)
  let generated: Awaited<ReturnType<typeof generateBusinessApp>> | null = null
  let requirementContract = businessAppState.requirementContract
  const activeBlueprint = resumeCandidate
    ? businessAppState.candidateBlueprint ?? businessAppState.blueprint
    : businessAppState.blueprint
  let reference: Awaited<ReturnType<typeof analyzeBusinessAppReference>> | null =
    attachments.length === 0 && resumeCandidate ? businessAppState.reference ?? null : null
  let referenceImage: string | null = attachments.length === 0 && resumeCandidate && reference
    ? [...rt.s.messages]
        .reverse()
        .flatMap(message => message.kind === 'user' ? message.attachmentUrls : [])
        .find(item => /^data:image\//i.test(item)) ?? null
    : null
  let draft: Awaited<ReturnType<typeof generateBusinessApp>>['draft'] | null = null
  let staticReport: ValidationReport | null = null
  let build: Awaited<ReturnType<typeof buildBusinessApp>> | null = null
  let runtime: Awaited<ReturnType<typeof validateBuiltBusinessApp>> | null = null
  let validationReport: ValidationReport | null = null
  let failedGates: ValidationGateResult[] = []
  let repairCount = 0
  let currentIssue: Issue | null = null
  let latestError = '业务应用生成未完成'
  let committed = false

  const executors: Record<string, NodeExecutor> = {
    /** 收敛需求契约；存在阻塞未知项时携带持久化产出挂起。 */
    requirements: {
      async execute() {
        activateStage(rt, 'st-1')
        const step = startStep(rt, 'st-1', '把业务目标收敛为可追踪、可验收的需求契约')
        const analysis = await analyzeBusinessAppRequirement(requirement, {
          decisions: businessAppState.decisions,
          currentBlueprint: activeBlueprint,
          settings: cachedSettings
        })
        requirementContract = analysis.contract
        businessAppState.requirementContract = analysis.contract
        businessAppState.pendingClarification = analysis.clarification
        save(rt)
        if (analysis.clarification) {
          finishStep(rt, step, `发现关键阻断项：${analysis.clarification.topic}；等待本轮一个回答`)
          emitBusinessAppClarification(rt, analysis.clarification)
          return {
            kind: 'suspend',
            reason: 'business-app-clarification',
            output: {
              contractStatus: analysis.contract.status,
              clarificationTopic: analysis.clarification.topic
            }
          }
        }
        businessAppState.pendingClarification = null
        finishStep(rt, step, `需求契约已就绪：${analysis.contract.capabilities.length} 项能力、${analysis.contract.acceptanceCriteria.length} 条验收标准`)
        finishStage(rt, 'st-1')
        return {
          kind: 'done',
          output: {
            contractStatus: 'ready',
            capabilityCount: analysis.contract.capabilities.length,
            acceptanceCount: analysis.contract.acceptanceCriteria.length
          }
        }
      }
    },
    /** 分析可选参考图，规划完整应用蓝图并收集 IDux 证据。 */
    planner: {
      async execute() {
        activateStage(rt, 'st-2')
        let step = startStep(
          rt,
          'st-2',
          attachments.length > 0 ? '分析业务应用参考图与业务目标' : '锁定产物类型与原始业务目标'
        )
        if (attachments.length > 0) {
          const capability = await getCapability()
          if (!capability.ok) {
            latestError = '模型能力探测失败，无法可靠分析业务应用参考图'
            throw new Error(latestError)
          }
          if (!capability.supportsVision) {
            latestError = '当前模型不支持图片理解，不能在忽略参考图的情况下生成业务应用'
            throw new Error(latestError)
          }
          referenceImage = attachments.find(item => /^data:image\//i.test(item)) ?? null
          if (!referenceImage) {
            latestError = '没有找到可分析的 PNG、JPEG 或 WebP 参考图'
            throw new Error(latestError)
          }
          let crops: string[] = []
          const replicaEnv = await probeReplicaEnv()
          if (replicaEnv.sharpOk) {
            const size = await imageSize(referenceImage)
            crops = await cropImageDataUrl(
              referenceImage,
              businessAppReferenceRegions(size.width, size.height)
            )
          }
          try {
            reference = await analyzeBusinessAppReference(
              cachedSettings,
              requirement,
              referenceImage,
              crops
            )
            businessAppState.reference = reference
            save(rt)
          } catch (error) {
            latestError = safeBusinessAppError(error)
            throw error
          }
          finishStep(
            rt,
            step,
            `已提取参考图的应用结构、导航、内容层级与视觉证据，置信度 ${reference.analysis.confidence}`
          )
        } else {
          finishStep(
            rt,
            step,
            reference
              ? '已恢复累计需求、失败候选与上一轮参考图蓝图'
              : '已锁定 Vue 3 + IDux 2.11.0 业务应用技术栈'
          )
        }
        finishStage(rt, 'st-2')

        activateStage(rt, 'st-3')
        step = startStep(rt, 'st-3', '通过 idux-cli 查询所需组件 API，并加载 idux-style 应用规范')
        if (!requirementContract || requirementContract.status !== 'ready') {
          throw new Error('需求契约未就绪，拒绝规划业务应用')
        }
        generated = await generateBusinessApp(
          workspace,
          requirementContract,
          {
            currentBlueprint: activeBlueprint,
            baseRevisionId,
            settings: cachedSettings,
            presentation: reference ? {
              navigation: reference.analysis.navigation === 'none' ? 'side' : reference.analysis.navigation,
              theme: reference.analysis.theme
            } : undefined,
            referenceAnalysis: reference?.analysis,
            referenceEvidence: reference?.evidence ?? (activeBlueprint ? businessAppState.reference?.evidence : undefined)
          }
        )
        draft = generated.draft
        businessAppState.candidateBlueprint = generated.blueprint
        businessAppState.candidateChangePlan = generated.changePlan
        save(rt)
        finishStep(
          rt,
          step,
          `证据版本 ${generated.evidence.iduxVersion}，提交 ${generated.evidence.sourceCommit.slice(0, 8)}`
            + (baseDraft ? `；已在${resumeCandidate ? '失败候选' : '当前应用蓝图'}上执行增量变更计划` : '')
        )
        finishStage(rt, 'st-3')
        return {
          kind: 'done',
          output: {
            iduxVersion: generated.evidence.iduxVersion,
            sourceCommit: generated.evidence.sourceCommit.slice(0, 8)
          }
        }
      }
    },
    /** 执行静态准入、保存候选草稿并进行受控生产构建。 */
    coder: {
      async execute() {
        activateStage(rt, 'st-4')
        const step = startStep(
          rt,
          'st-4',
          repairCount === 0 ? '校验源码并执行受控离线构建' : `应用第 ${repairCount} 轮修复后重新构建`
        )
        try {
          if (!generated || !draft) throw new Error('业务应用的 IDux 组件证据或源码草稿缺失')
          validateBusinessAppBuildInput(draft)
          staticReport = artifactRegistry.get('business-app').validateDraft(draft)
          failedGates = staticReport.gates.filter(gate => gate.status === 'failed')
          if (failedGates.length > 0) {
            latestError = failedGates[0]?.detail || failedGates[0]?.title || '业务应用源码门禁未通过'
            finishStep(rt, step, `发现 ${failedGates.length} 项源码问题，进入自动修复`)
            finishStage(rt, 'st-4')
            return {
              kind: 'done',
              output: { passed: false, issueCount: failedGates.length, attempt: repairCount + 1 }
            }
          }

          store.writeArtifactDraft(rt.s.dashboard.id, revisionId, draft)
          store.writeArtifactEvidence(rt.s.dashboard.id, revisionId, generated.evidence)
          build = await buildBusinessApp(workspace, outputDir)
          finishStep(rt, step, `构建完成，用时 ${(build.durationMs / 1000).toFixed(1)} 秒`)
          finishStage(rt, 'st-4')
          return {
            kind: 'done',
            output: { passed: true, issueCount: 0, attempt: repairCount + 1 }
          }
        } catch (error) {
          latestError = safeBusinessAppError(error)
          failedGates = [{
            id: 'production-build',
            title: '生产构建成功',
            status: 'failed',
            detail: latestError
          }]
          finishStep(rt, step, `${latestError}；进入自动修复`)
          finishStage(rt, 'st-4')
          return {
            kind: 'done',
            output: { passed: false, issueCount: 1, attempt: repairCount + 1 }
          }
        }
      }
    },
    /** 执行双视口结构、交互场景、安全网络和视觉模型复核。 */
    check: {
      async execute() {
        activateStage(rt, 'st-5')
        const step = startStep(rt, 'st-5', '在 1920×1080 与 1366×768 执行需求场景、浏览器与视觉验收')
        if (!generated || !staticReport || !build || !draft) {
          return { kind: 'failed', error: new Error('业务应用构建结果不完整，不能执行浏览器验收') }
        }
        const url = artifactPreviewUrl(rt.s.dashboard.id, revisionId, Date.now())
        runtime = await validateBuiltBusinessApp(url, generated.blueprint.acceptanceScenarios)
        const visualReview = await reviewBusinessAppVisual(
          cachedSettings,
          requirement,
          runtime.screenshot,
          runtime.smallScreenshot,
          referenceImage,
          runtime.scenarioScreenshots
        )
        validationReport = {
          status: 'pending',
          gates: [
            ...staticReport.gates,
            {
              id: 'production-build',
              title: '生产构建成功',
              status: 'passed',
              detail: `${runtimeVersionLabel()}，${(build.durationMs / 1000).toFixed(1)} 秒`
            },
            ...runtime.gates,
            ...visualReview.gates
          ]
        }
        failedGates = validationReport.gates.filter(gate => gate.status === 'failed')
        validationReport.status = failedGates.length === 0 ? 'passed' : 'failed'

        if (failedGates.length > 0) {
          latestError = failedGates[0]?.detail || failedGates[0]?.title || '浏览器质量验收失败'
          if (!currentIssue) {
            const issueId = nextId('issue')
            currentIssue = {
              id: issueId,
              stageId: 'st-6',
              title: latestError,
              attempt: repairCount + 1,
              status: 'fixing',
              beforeShotUrl: runtime.screenshot
                ? persistShot(
                    rt,
                    issueId,
                    'before',
                    `data:image/png;base64,${runtime.screenshot.toString('base64')}`
                  )
                : null,
              afterShotUrl: null,
              detail: `${iduxFailureContract(failedGates)}\n当前策略：执行有边界的自动修复。`
            }
          } else {
            currentIssue = {
              ...currentIssue,
              title: latestError,
              attempt: repairCount + 1,
              status: 'fixing',
              detail: `${iduxFailureContract(failedGates)}\n第 ${repairCount + 1} 轮复检仍有 ${failedGates.length} 项阻断问题。`
            }
          }
          setIssue(rt, currentIssue)
          finishStep(rt, step, `发现 ${failedGates.length} 项阻断问题，进入自动修复`)
        } else {
          if (runtime.screenshot) store.writeCover(rt.s.dashboard.id, runtime.screenshot)
          if (currentIssue) {
            currentIssue = {
              ...currentIssue,
              status: 'fixed',
              afterShotUrl: runtime.screenshot
                ? persistShot(
                    rt,
                    currentIssue.id,
                    'after',
                    `data:image/png;base64,${runtime.screenshot.toString('base64')}`
                  )
                : null,
              detail: `经过 ${repairCount} 轮自动修复，全部质量门禁复检通过。`
            }
            setIssue(rt, currentIssue)
          }
          finishStep(rt, step, `共 ${validationReport.gates.length} 项质量门禁通过`)
        }
        finishStage(rt, 'st-5')
        return {
          kind: 'done',
          output: {
            passed: failedGates.length === 0,
            issueCount: failedGates.length,
            attempt: repairCount + 1
          }
        }
      }
    },
    /** 按确定性、模型、定向重生成和证据扩展阶梯自主修复。 */
    repair: {
      async execute() {
        activateStage(rt, 'st-6')
        const step = startStep(rt, 'st-6', `诊断并修复第 ${repairCount + 1} 轮质量问题`)
        if (!draft) {
          latestError = '没有可修复的业务应用源码草稿'
          finishStep(rt, step, latestError, 'failed')
          return { kind: 'failed', error: new Error(latestError) }
        }
        if (repairCount >= 4) {
          latestError = `已依次尝试确定性修复、模型补丁、定向重生成和证据扩展，仍未通过：${latestError}`
          if (currentIssue) {
            currentIssue = { ...currentIssue, status: 'failed', detail: latestError }
            setIssue(rt, currentIssue)
          }
          finishStep(rt, step, latestError, 'failed')
          return { kind: 'suspend', reason: 'idux-quality-strategies-exhausted' }
        }
        if (!currentIssue) {
          currentIssue = {
            id: nextId('issue'),
            stageId: 'st-6',
            title: latestError,
            attempt: repairCount + 1,
            status: 'fixing',
            beforeShotUrl: null,
            afterShotUrl: null,
            detail: `${iduxFailureContract(failedGates)}\n正在按策略阶梯自动修复。`
          }
          setIssue(rt, currentIssue)
        }
        const attempted = new Set(businessAppState.strategiesTried)
        let repaired = repairBusinessAppDraft(draft, failedGates)
        let strategy = 'deterministic-repair'
        if (attempted.has(strategy) || repaired.actions.length === 0) {
          repaired = { draft, actions: [] }
          strategy = 'model-source-repair'
        }
        if (strategy === 'model-source-repair' && !attempted.has(strategy)) {
          const modelRepair = await repairBusinessAppWithModel(
            draft,
            requirement,
            failedGates,
            cachedSettings
          ).catch(() => null)
          if (modelRepair) repaired = modelRepair
        }
        if (repaired.actions.length === 0) {
          const issueContract = failedGates
            .map(gate => `${gate.id}：期望“${gate.title}”；实际“${gate.detail ?? '未通过'}”`)
            .join('；')
          strategy = !attempted.has('targeted-regeneration')
            ? 'targeted-regeneration'
            : 'evidence-expanded-replan'
          if (attempted.has(strategy)) {
            latestError = `全部自主修复策略已经执行且复检失败：${latestError}`
            finishStep(rt, step, latestError, 'failed')
            return { kind: 'suspend', reason: 'idux-quality-strategies-exhausted' }
          }
          if (!requirementContract) throw new Error('缺少可追踪的需求契约，不能重新规划')
          const repairContract: BusinessAppRequirementContract = {
            ...requirementContract,
            constraints: [
              ...requirementContract.constraints,
              `定向修复以下验收问题：${issueContract}`,
              ...(strategy === 'evidence-expanded-replan'
                ? ['重新核对所有相关 IDux 组件证据和完整交互状态']
                : [])
            ]
          }
          generated = await generateBusinessApp(workspace, repairContract, {
            currentBlueprint: generated?.blueprint ?? businessAppState.candidateBlueprint ?? businessAppState.blueprint,
            baseRevisionId,
            settings: cachedSettings,
            presentation: reference ? {
              navigation: reference.analysis.navigation === 'none' ? 'side' : reference.analysis.navigation,
              theme: reference.analysis.theme
            } : undefined,
            referenceAnalysis: reference?.analysis,
            referenceEvidence: reference?.evidence ?? (activeBlueprint ? businessAppState.reference?.evidence : undefined)
          })
          repaired = {
            draft: generated.draft,
            actions: [strategy === 'evidence-expanded-replan'
              ? '扩展组件证据后重新规划并生成受控页面'
              : '依据失败的验收场景定向重新生成受控页面']
          }
          businessAppState.candidateBlueprint = generated.blueprint
          businessAppState.candidateChangePlan = generated.changePlan
        }
        draft = repaired.draft
        validateBusinessAppBuildInput(draft)
        store.writeArtifactDraft(rt.s.dashboard.id, revisionId, draft)
        businessAppState.strategiesTried.push(strategy)
        repairCount += 1
        finishStep(rt, step, `${repaired.actions.join('；')}（策略：${strategy}）`)
        finishStage(rt, 'st-6')
        return {
          kind: 'done',
          output: {
            repairCount,
            issueCount: failedGates.length
          }
        }
      }
    },
    /** 只在质量报告全部通过后允许进入原子提交。 */
    finish: {
      async execute() {
        if (rt.s.stages.find(stage => stage.id === 'st-6')?.state !== 'done') {
          finishStage(rt, 'st-6')
        }
        activateStage(rt, 'st-7')
        const step = startStep(rt, 'st-7', '固化需求契约、应用蓝图、证据、校验报告与可预览版本')
        if (!generated || !draft || !runtime || validationReport?.status !== 'passed') {
          latestError = '质量闭环尚未通过，拒绝提交版本'
          finishStep(rt, step, latestError, 'failed')
          return { kind: 'failed', error: new Error(latestError) }
        }
        finishStep(rt, step, repairCount > 0 ? `完成 ${repairCount} 轮修复并复检` : '首次验收即通过')
        finishStage(rt, 'st-7')
        return { kind: 'done', output: { passed: true, repairCount } }
      }
    }
  }

  try {
    let engine: ReturnType<typeof createLoop>
    engine = createLoop({
      flowId: 'business-app-generation',
      flowVersion: 2,
      definition: BUSINESS_APP_FLOW,
      resume: {
        resume: {
          'business-app-clarification': { node: 'requirements' }
        }
      },
      executors,
      stepTimeoutMs: 10 * 60 * 1000,
      onNodeComplete: (_nodeId, graphState) => {
        emitBusinessAppGraph(rt, businessAppGraphSnapshot(graphState))
        businessAppState.checkpoint = engine.getCheckpoint()
        save(rt)
      },
      onCommit: async graphState => {
        emitBusinessAppGraph(rt, businessAppGraphSnapshot(graphState))
        if (!generated || !draft || !runtime || !validationReport || validationReport.status !== 'passed') {
          throw new Error('业务应用闭环结果不完整，拒绝提交版本')
        }
        const url = artifactPreviewUrl(rt.s.dashboard.id, revisionId, Date.now())
        const n = rt.s.versions.length + 1
        const coverUrl = runtime.screenshot
          ? `/covers/${rt.s.dashboard.id}.png?t=${Date.now()}`
          : rt.s.dashboard.coverUrl
        const version: Version = {
          id: revisionId,
          label: `v${n}`,
          summary: rt.s.versions.length === 0
            ? '业务应用初版完成'
            : truncate(request) || '更新业务应用',
          createdAt: Date.now(),
          screenshotUrl: coverUrl,
          published: false,
          isCurrent: true,
          manifest: artifactRegistry.get('business-app').createManifest(draft),
          validationReport
        }
        addVersion(rt, version, url)
        previewReady(rt, revisionId, url)
        pushAgent(
          rt,
          `业务应用已通过 ${validationReport.gates.length} 项质量门禁`
            + (repairCount > 0 ? `，并完成 ${repairCount} 轮自动修复与复检。` : '。')
        )
        updateDashboard(rt, {
          status: 'completed',
          coverUrl,
          targetProfile: artifactRegistry.get('business-app').createTargetProfile()
        })
        committed = true
        businessAppState.unresolved = false
        businessAppState.candidateRevisionId = null
        businessAppState.strategiesTried = []
        businessAppState.lastFailure = null
        businessAppState.requirementContract = generated.contract
        businessAppState.blueprint = generated.blueprint
        businessAppState.changePlan = generated.changePlan
        businessAppState.candidateBlueprint = null
        businessAppState.candidateChangePlan = null
        businessAppState.pendingClarification = null
        businessAppState.checkpoint = null
        save(rt)
      }
    })
    if (resumeCandidate && businessAppState.checkpoint?.awaiting === 'business-app-clarification') {
      await engine.handleEvent({ kind: 'restore-checkpoint', checkpoint: businessAppState.checkpoint })
      await engine.handleEvent({ kind: 'resume' })
    } else {
      await engine.handleEvent({ kind: 'start', initialNode: 'requirements' })
    }
    if (engine.getState() === 'suspended' && businessAppState.pendingClarification) {
      businessAppState.checkpoint = engine.getCheckpoint()
      save(rt)
      return
    }
    if (engine.getState() === 'blocked' || !committed) {
      throw new Error(latestError)
    }
  } catch (error) {
    const message = safeBusinessAppError(error)
    const issue = currentIssue as Issue | null
    if (issue) {
      const failedIssue: Issue = { ...issue, status: 'failed', detail: message }
      currentIssue = failedIssue
      setIssue(rt, failedIssue)
    } else {
      setIssue(rt, {
        id: nextId('issue'),
        stageId: rt.s.stages.find(stage => stage.state === 'active')?.id ?? 'st-1',
        title: message,
        attempt: Math.max(1, repairCount + 1),
        status: 'failed',
        beforeShotUrl: null,
        afterShotUrl: null,
        detail: '质量门禁阻止了不可靠的业务应用进入版本历史。'
      })
    }
    pushAgent(rt, `这次业务应用没有进入版本历史：${message}`)
    businessAppState.unresolved = true
    businessAppState.candidateRevisionId = revisionId
    businessAppState.lastFailure = message
    save(rt)
    failActiveStage(rt, message)
    const exhaustedStrategies = businessAppState.strategiesTried.length >= 3
    const options: CardOption[] = [
      ...(!exhaustedStrategies ? [{
        id: 'opt-idux-retry',
        title: '继续自主修复',
        consequence: '保留需求契约、失败候选和验收证据，执行剩余策略',
        recommended: true,
        recommendReason: '仍有尚未执行的自主策略',
        riskLevel: 'low' as const,
        autoExecuteAt: null
      }] : []),
      {
        id: 'opt-idux-adjust',
        title: '调整需求',
        consequence: '补充或改变验收目标后继续，原需求仍会保留在项目上下文中',
        recommended: exhaustedStrategies,
        recommendReason: exhaustedStrategies ? '所有自主修复策略已经执行并复检失败，需要新的业务约束才能改变结果' : null,
        riskLevel: 'medium',
        autoExecuteAt: null
      },
      {
        id: 'opt-assist',
        title: '人工协助',
        consequence: '把完整失败轨迹交给支持人员检查',
        recommended: false,
        recommendReason: null,
        riskLevel: 'medium',
        autoExecuteAt: null
      }
    ]
    const problem: ProblemMessage = {
      kind: 'problem',
      id: nextId('m'),
      createdAt: Date.now(),
      title: exhaustedStrategies ? '自主修复策略已全部尝试' : '当前环境无法继续自主修复',
      description: message,
      options,
      chosenOptionId: null,
      relatedIssueId: currentIssue?.id ?? null
    }
    pushMessage(rt, problem)
    setBlocker(rt, {
      id: nextId('blk'),
      type: 'failed',
      title: problem.title,
      description: problem.description,
      options,
      relatedMessageId: problem.id
    })
    setStatus(rt, 'blocked')
    updateDashboard(rt, { status: 'needs_attention' })
  } finally {
    rt.running = false
    if (committed) setStatus(rt, 'idle')
    drainQueue(rt)
  }
}

/** 返回质量报告展示使用的固定构建运行时版本。 */
function runtimeVersionLabel(): string {
  return 'Vite 6.4.3'
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
  if (rt.s.dashboard.artifactKind === 'business-app') {
    void runBusinessAppGeneration(rt, text, attachments)
  } else {
    startEditFlow(rt, text, attachments)
  }
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
  // 编辑复用生成时落盘的数据快照（没有就是 undefined，Coder prompt 渲染为空串），不重新取数
  run.pending.dataBlock = rt.s.lastDataBlock
  run.pending.dataSourcesUsed = rt.s.lastDataSourcesUsed // 复用明细，让新版本也能展示数据来源
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
  const editStep = startStep(rt, 'st-1', '修改页面')
  const ctl = new AbortController()
  run.abort = ctl
  try {
    run.html = await callCoderEdit(currentHtml, run.pending.text || '按用户发的参考图调整', run.pending.dataBlock ?? '', llmProgress(rt, 'st-1', '正在修改页面'), ctl.signal)
  } catch (err) {
    if (run.watchdogAborted === ctl) return // 看门狗已接管（自动拆分步骤）
    finishStep(rt, editStep, '没改完', 'failed')
    raiseLlmFailureCard(rt, run, err, 'st-1')
    run.retryLlm = () => void runEdit(rt, run)
    rt.running = false
    return
  } finally {
    if (run.abort === ctl) run.abort = null
    disarmAgentWatchdog(rt, run, wdEdit)
  }
  finishStep(rt, editStep, '改完了')
  finishStage(rt, 'st-1')
  activateStage(rt, 'st-2')
  await sleep(700)
  finishStage(rt, 'st-2')
  await checkRepairAndFinish(rt, run, 'st-3', null, 'st-3')
}

/* ============================== 消息入口 ============================== */

/** 接收用户消息，并按当前运行状态路由到新建、增量、澄清或失败恢复流程。 */
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
      if (rt.s.dashboard.artifactKind === 'business-app') {
        void runBusinessAppGeneration(rt, text, attachments)
        break
      }
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
      if (rt.s.dashboard.artifactKind === 'business-app') {
        setBlocker(rt, null)
        void runBusinessAppGeneration(rt, text, attachments)
      } else {
        handleFreeTextDuringBlocked(rt, text)
      }
      break
    case 'assisting':
      pushAgent(rt, '支持人员正在处理，稍等一下～')
      break
  }
}

/* ============================== 澄清回答 ============================== */

/** 保存结构化澄清回答，并恢复对应产物类型的挂起流程。 */
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
    if (rt.s.dashboard.artifactKind === 'business-app') {
      continueBusinessAppAfterClarification(rt, m, answers)
      return
    }
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
  if (rt.s.dashboard.artifactKind === 'business-app' && m) {
    continueBusinessAppAfterClarification(rt, m, [{
      questionId: m.questions[0]?.id ?? 'business-app-question',
      optionId: '',
      customText: text
    }])
    return
  }
  pushAgent(rt, '好的，就按你说的来。')
  continueAfterClarification(rt, m ?? null)
}

/**
 * 将单问题回答写入 business-app 决策历史，并触发同一候选版本续跑。
 * 下一轮仍先重新分析阻塞未知项，不会绕过需求就绪检查直接生成。
 */
function continueBusinessAppAfterClarification(
  rt: Runtime,
  message: ClarificationMessage,
  answers: ClarificationAnswer[]
): void {
  const state = getBusinessAppState(rt)
  const clarification = state.pendingClarification
  const question = message.questions[0]
  const answer = answers.find(item => item.questionId === question?.id)
  const option = question?.options.find(item => item.id === answer?.optionId)
  const value = answer?.customText?.trim() || option?.title || question?.answer?.trim() || ''
  if (!clarification || !question || !value) {
    pushAgent(rt, '这项回答还没有有效内容，请重新补充。')
    return
  }
  state.decisions.push({
    id: nextId('decision'),
    questionId: clarification.topic,
    question: clarification.question,
    answer: value,
    source: answer?.customText?.trim() ? 'custom' : 'option',
    createdAt: Date.now()
  })
  state.decisions = state.decisions.slice(-30)
  setBlocker(rt, null)
  pushAgent(rt, '这项已确认。我会先继续检查剩余关键边界；只有需求契约就绪后才开始生成。')
  save(rt)
  void runBusinessAppGeneration(rt, '继续', [])
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
    case 'opt-idux-retry': {
      pushAgent(rt, '我会保留失败候选、需求契约和验收证据，继续执行自主诊断与修复。')
      void runBusinessAppGeneration(rt, '继续', [])
      break
    }
    case 'opt-idux-adjust': {
      pushAgent(rt, '请直接补充需要调整的业务目标或验收结果；我会把它作为新的变更需求重新收敛。')
      setStatus(rt, 'idle')
      break
    }
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
        // 用最接近的模板：给默认布局打底（取目录第一个 layout，无目录则全自定义）
        const firstLayout = templatesByType('layout')[0]?.id ?? null
        run.pending.template = { layoutId: firstLayout, modules: [], useTemplate: true }
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
        const stageId = run.watchdogStageId ?? (run.pending.kind === 'create' ? createStageIds().code : 'st-1')
        void splitCodingFlow(rt, run, stageId)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-demo-data': {
      // 数据源卡点「改用演示数据继续」：快照置空（Coder 用演示数据），走 proceed 继续编码
      if (run) {
        run.pending.dataBlock = ''
        rt.s.lastDataBlock = ''
        run.pending.dataSourcesUsed = [] // 演示数据 = 无数据源
        rt.s.lastDataSourcesUsed = []
        run.pending.awaiting = null
        save(rt)
        if (run.proceed) run.proceed()
        else if (run.pending.kind === 'create') void continueCreateToCoding(rt, run)
        else void runEdit(rt, run)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
      break
    }
    case 'opt-retry-datasource': {
      // 数据源卡点「再试一次取数」：清掉快照标记，重进流程会重新取数
      if (run) {
        run.pending.dataBlock = undefined
        run.pending.dataSourcesUsed = undefined
        run.pending.awaiting = null
        save(rt)
        if (run.retryLlm) run.retryLlm()
        else if (run.pending.kind === 'create') void continueCreateToCoding(rt, run)
        else void runEdit(rt, run)
      } else {
        setStatus(rt, 'idle')
        drainQueue(rt)
      }
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

/** 重启后内存态丢失：按落盘的 pendingRun 重建可续跑的 ActiveRun（最大努力；dataBlock 快照随 pendingRun 恢复） */
function rebuildActiveRun(rt: Runtime): ActiveRun | null {
  const pending = rt.s.pendingRun
  if (!pending) return null
  const run: ActiveRun = { pending, html: '', retryRepair: null, retryLlm: null, proceed: null }
  const current = rt.s.versions.find((v) => v.isCurrent) ?? rt.s.versions[0]
  run.html = current ? (store.readPreview(rt.s.dashboard.id, current.id) ?? '') : ''
  const ids = createStageIds()
  if (pending.awaiting === 'problem') {
    run.retryRepair = () => void resumeRepair(rt, run, pending.kind === 'create' ? ids.check : 'st-3', pending.kind === 'create' ? ids.repair : 'st-3')
    // 首次创建在编码产出之前被卡点(如数据源连不上)时没有任何可提交的产物:
    // proceed 不能直接 commit 空 HTML,要重进流程继续走编码
    run.proceed = run.html
      ? () => void finishRunCommit(rt, run, pending.kind === 'create' ? ids.repair : 'st-3')
      : pending.kind === 'create'
        ? () => void continueCreateToCoding(rt, run)
        : () => void runEdit(rt, run)
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
  // 继承原版本的数据来源明细（回退产物是同一份页面，数据来源不变）
  const inheritedMeta = store.readVersionMeta<DataUseEntry[]>(rt.s.dashboard.id, versionId)
  const n = rt.s.versions.length + 1
  const id = nextId('ver')
  if (target.manifest.kind === 'business-app') {
    store.copyArtifactRevision(rt.s.dashboard.id, versionId, id)
  } else {
    store.copyPreviewRevision(rt.s.dashboard.id, versionId, id)
  }
  const url = artifactPreviewUrl(rt.s.dashboard.id, id)
  const v: Version = {
    id,
    label: `v${n}`,
    summary: `回退到 ${target.label}`,
    createdAt: Date.now(),
    screenshotUrl: target.screenshotUrl,
    published: false,
    isCurrent: true,
    dataSourcesUsed: inheritedMeta && inheritedMeta.length > 0 ? inheritedMeta : undefined,
    manifest: target.manifest,
    validationReport: target.validationReport
  }
  addVersion(rt, v, url)
  previewReady(rt, id, url)
  pushSystem(rt, `已回退到 ${target.label} 版本（${target.label} 之后的记录都还在，随时可以回来）`)
  updateDashboard(rt, {})
}

export function handleRollback(dashId: string, versionId: string): void {
  doRollback(mustRuntime(dashId), versionId)
}

/* ============================== F6 发布（真实发布到 AiLab CodeBox） ============================== */

/** 当前大屏项目对应的 CodeBox 名称（复用同名 CodeBox，避免反复创建）。
 *  用 dashId 生成 slug（稳定唯一、永不为中文），而非易变的 dashName —— 同一个大屏始终复用同一个 CodeBox。 */
function codeBoxName(dashId: string): string {
  return `${projectSlug(dashId)}-dev`
}

/** 发布进度内存标记：记录每个大屏当前是否正在发布（防并发，handlePublish 幂等判断用） */
const publishingDashboards = new Set<string>()

/** 推送发布进度事件（publishProgress，发布弹窗独占订阅；不进对话区/右栏） */
function emitPublishProgress(
  rt: Runtime,
  phase: PublishPhase,
  message: string,
  extra?: { publicUrl?: string; error?: string }
): void {
  const payload: PublishProgress = {
    dashboardId: rt.s.dashboard.id,
    phase,
    message,
    publicUrl: extra?.publicUrl,
    error: extra?.error
  }
  store.emit(rt.s.dashboard.id, 'publishProgress', payload)
}

/**
 * 真实发布主流程（异步推进，进度通过 publishProgress 事件实时推给发布弹窗）。
 * 任何环节失败推 failed 进度；成功把 publicUrl 写进当前版本并标记已发布。
 */
const MAX_PUBLISH_HTML_BYTES = 20 * 1024 * 1024

function trustedPreviewAsset(
  projectId: string,
  revisionId: string,
  reference: string,
  relativeTo = ''
): { content: Buffer; filePath: string } {
  const cleanReference = reference.split(/[?#]/, 1)[0]
  if (
    !cleanReference ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(cleanReference) ||
    cleanReference.includes('\0')
  ) {
    throw new PublishError(`业务应用发布产物包含不受信任的资源地址：${reference}`)
  }
  const root = fs.realpathSync(store.previewDir(projectId, revisionId))
  const normalizedReference = decodeURIComponent(cleanReference).replace(/^\/+/, '')
  const candidate = path.resolve(root, relativeTo, normalizedReference)
  const filePath = fs.realpathSync(candidate)
  const relative = path.relative(root, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PublishError(`业务应用发布资源越出了受控预览目录：${reference}`)
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new PublishError(`业务应用发布资源不是普通文件：${reference}`)
  }
  return { content: fs.readFileSync(filePath), filePath }
}

function assetMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const types: Record<string, string> = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  }
  const mime = types[extension]
  if (!mime) throw new PublishError(`业务应用样式引用了不允许内联的资源类型：${extension || '未知'}`)
  return mime
}

function inlineCssAssets(
  projectId: string,
  revisionId: string,
  cssFilePath: string,
  css: string
): string {
  const previewRoot = fs.realpathSync(store.previewDir(projectId, revisionId))
  const relativeDirectory = path.relative(previewRoot, path.dirname(cssFilePath))
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote, reference: string) => {
    if (/^(?:data:|#)/i.test(reference.trim())) return match
    const asset = trustedPreviewAsset(projectId, revisionId, reference.trim(), relativeDirectory)
    return `url("data:${assetMimeType(asset.filePath)};base64,${asset.content.toString('base64')}")`
  })
}

function inlineBusinessAppPreview(projectId: string, revisionId: string, html: string): string {
  let result = html.replace(/<link\b[^>]*>/gi, tag => {
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) return tag
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href) throw new PublishError('业务应用发布产物的样式标签缺少 href')
    const asset = trustedPreviewAsset(projectId, revisionId, href)
    const css = inlineCssAssets(projectId, revisionId, asset.filePath, asset.content.toString('utf8'))
    return `<style data-inlined-from="${path.basename(asset.filePath)}">${css}</style>`
  })
  result = result.replace(
    /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi,
    (_tag, before, source, after) => {
      const asset = trustedPreviewAsset(projectId, revisionId, source)
      const script = asset.content.toString('utf8')
      if (/\b(?:import\s*(?:\(|["'{*])|export\s+(?:\*|{))/m.test(script)) {
        throw new PublishError('业务应用构建结果包含拆分模块，当前发布器无法安全合并，请重新生成后再试')
      }
      return `<script${before}${after}>${script}</script>`
    }
  )
  if (Buffer.byteLength(result, 'utf8') > MAX_PUBLISH_HTML_BYTES) {
    throw new PublishError('业务应用发布产物内联后超过 20MB 安全上限')
  }
  if (/(?:src|href)\s*=\s*["']\s*(?:\.?\/)?assets\//i.test(result)) {
    throw new PublishError('业务应用发布产物仍包含未内联的本地资源')
  }
  return result
}

async function runPublish(rt: Runtime, cur: Version): Promise<void> {
  const dashId = rt.s.dashboard.id
  try {
    if (cur.validationReport.status !== 'passed') {
      throw new PublishError('当前版本没有通过全部质量门禁，已阻止发布')
    }
    emitPublishProgress(rt, 'uploading', '正在准备云端环境（创建/复用 CodeBox、配置访问）…')
    const html = store.readPreview(dashId, cur.id)
    if (html === null) throw new PublishError('这个版本的页面文件找不到了，可能已被清理')
    // 发布单文件：把 data.json 内联进 HTML（云端只上传 index.html，需自带数据）
    const htmlToPublish = cur.manifest.kind === 'business-app'
      ? inlineBusinessAppPreview(dashId, cur.id, html)
      : inlineDataIntoHtml(html, store.readDataFileText(dashId, cur.id))
    const cfg = { ...cachedPublishConfig }
    const name = codeBoxName(dashId)
    emitPublishProgress(rt, 'uploading', '正在把大屏上传到云端…')
    // 上传完成后切到 serving 阶段（起服务 + 暴露公网）
    emitPublishProgress(rt, 'serving', '正在云端启动服务并发布到公网…')
    const result = await publishToAilab(cfg, name, htmlToPublish)
    // 成功：写 publicUrl + 标记已发布
    upsertVersion(rt, { ...cur, published: true, publicUrl: result.publicUrl })
    updateDashboard(rt, { status: 'published' })
    emitPublishProgress(rt, 'success', `大屏已发布，公网访问地址：${result.publicUrl}`, { publicUrl: result.publicUrl })
  } catch (err) {
    const detail = err instanceof PublishError ? err.message : err instanceof Error ? err.message : String(err)
    emitPublishProgress(rt, 'failed', '发布没有成功，大屏内容都还在，可以稍后再试', { error: detail })
  } finally {
    publishingDashboards.delete(dashId)
  }
}

export function handlePublish(dashId: string): void {
  const rt = mustRuntime(dashId)
  if (rt.s.runStatus !== 'idle' || rt.s.versions.length === 0) return
  if (publishingDashboards.has(dashId)) return // 防并发：已有进行中的发布
  const cur = rt.s.versions.find((v) => v.isCurrent)
  if (!cur) return
  publishingDashboards.add(dashId)
  emitPublishProgress(rt, 'uploading', '已开始发布到云端，稍等一两分钟。')
  // 真实发布是异步子进程流程；不放进 after（after 无错误网），直接 fire-and-forget
  void runPublish(rt, cur)
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
            const proceed = run.proceed ?? (() => void finishRunCommit(rt, run, run.pending.kind === 'create' ? createStageIds().repair : 'st-3'))
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
    steps: [],
    issues: [],
    blocker: null,
    versions: [],
    versionUrls: {},
    preview: { state: 'empty', url: null },
    graph: null,
    assistSession: null,
    previewResolution: '1920x1080',
    pendingRun: null,
    businessAppState: undefined
  }
}

function makeRuntime(s: SessionData): Runtime {
  // 重启恢复：进行中的任务状态落回空闲，等待中的卡点保留（靠 pendingRun 重建续跑）
  if (s.runStatus === 'generating' || s.runStatus === 'assisting') {
    s.runStatus = 'idle'
    s.pendingRun = null
    const interruptedAt = Date.now()
    for (const stage of s.stages ?? []) {
      if (stage.state === 'active') {
        stage.state = 'failed'
        stage.finishedAt = interruptedAt
        stage.detail = '服务重启中断了本轮执行，可继续恢复失败候选'
      }
    }
    for (const step of s.steps ?? []) {
      if (step.state === 'active') {
        step.state = 'failed'
        step.finishedAt = interruptedAt
        step.detail = '服务重启中断'
      }
    }
  }
  s.dashboard.artifactKind ??= 'dashboard'
  s.dashboard.targetProfile ??= targetProfileFor(s.dashboard.artifactKind)
  const currentRevision = s.versions.find((version) => version.isCurrent) ?? null
  s.dashboard.currentRevisionId ??= currentRevision?.id ?? null
  for (const version of s.versions) {
    version.manifest ??= manifestFor(s.dashboard.artifactKind)
    version.validationReport ??= passedValidationReport('历史产物按兼容规则登记')
  }
  s.assistSession = null
  s.steps ??= [] // 旧版会话文件没有执行轨迹字段
  s.graph ??= null // 旧版会话文件没有流程图快照字段
  if (s.dashboard.artifactKind === 'business-app') getBusinessAppState({ s } as Runtime)
  s.preview.url = normalizePreviewUrl(s.preview.url)
  for (const [versionId, url] of Object.entries(s.versionUrls)) {
    s.versionUrls[versionId] = normalizePreviewUrl(url) ?? url
  }
  const rt: Runtime = { s, running: false, queue: [], activeRun: null, autoTimer: null, timers: new Set(), stepsResetPending: false }
  sessions.set(s.dashboard.id, rt)
  return rt
}

function mustRuntime(dashId: string): Runtime {
  const rt = sessions.get(dashId)
  if (!rt) throw new HttpError(404, `项目不存在：${dashId}`)
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
    steps: [...rt.s.steps],
    issues: [...rt.s.issues],
    blocker: rt.s.blocker,
    versions: [...rt.s.versions],
    preview: { ...rt.s.preview },
    graph: rt.s.graph,
    assistSession: rt.s.assistSession
  }
}

/**
 * 同步 adapter 的 session 数据到 orchestrator 的 Runtime（供 loop-adapter 调用）。
 * adapter 管理 messages/stages/versions/runStatus，但前端读数据走 orchestrator（enterDashboard/snapshotOf），
 * 需要此函数把 adapter 的状态同步进 orchestrator 的内存 Runtime。
 */
export function syncAdapterSession(dashId: string, patch: {
  messages?: ChatMessage[]
  stages?: Stage[]
  steps?: AgentStep[]
  issues?: Issue[]
  versions?: Version[]
  versionUrls?: Record<string, string>
  runStatus?: RunStatus
  blocker?: Blocker | null
  preview?: { state: 'empty' | 'building' | 'ready'; url: string | null }
  graph?: GraphSnapshot | null
}): void {
  const rt = sessions.get(dashId)
  if (!rt) return
  if (patch.messages !== undefined) rt.s.messages = patch.messages
  if (patch.stages !== undefined) rt.s.stages = patch.stages
  if (patch.steps !== undefined) rt.s.steps = patch.steps
  if (patch.issues !== undefined) rt.s.issues = patch.issues
  if (patch.versions !== undefined) rt.s.versions = patch.versions
  if (patch.versionUrls !== undefined) rt.s.versionUrls = patch.versionUrls
  if (patch.runStatus !== undefined) rt.s.runStatus = patch.runStatus
  if (patch.blocker !== undefined) rt.s.blocker = patch.blocker
  if (patch.preview !== undefined) rt.s.preview = patch.preview
  if (patch.graph !== undefined) rt.s.graph = patch.graph
  save(rt)
}

/**
 * 同步 adapter 的 dashboard 字段到 orchestrator Runtime（供 loop-adapter 调用）。
 * 复用 updateDashboard 的全部副作用：更新字段、发 dashboardUpdated SSE、持久化。
 * 用于 loop-adapter 提交版本后设置 coverUrl/status，让首页缩略图和状态徽标正确刷新。
 */
export function syncAdapterDashboard(dashId: string, patch: Partial<Dashboard>): void {
  const rt = sessions.get(dashId)
  if (!rt) return
  updateDashboard(rt, patch)
}

/* ---------- 对外 API ---------- */

export function listDashboards(): Dashboard[] {
  return [...sessions.values()].map((rt) => ({ ...rt.s.dashboard }))
}

export const listProjects = listDashboards

export function listGenerationCapabilities(): Array<{
  artifactKind: ArtifactKind
  targetProfile: TargetProfile
  skills: Array<{ id: string; name: string; description: string }>
}> {
  return artifactRegistry.list().map((adapter) => ({
    artifactKind: adapter.kind,
    targetProfile: adapter.createTargetProfile(),
    skills: skillRegistry.forArtifact(adapter.kind).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description
    }))
  }))
}

function persistDashboards(): void {
  store.saveDashboards(listDashboards())
}

export function getArtifactKind(id: string): ArtifactKind {
  return mustRuntime(id).s.dashboard.artifactKind
}

export function createDashboard(name: string): Dashboard {
  return createProject(name, 'dashboard')
}

export function createProject(name: string, artifactKind: ArtifactKind): Dashboard {
  const dash: Dashboard = {
    id: nextId('dash'),
    name: name.trim() || (artifactKind === 'dashboard' ? '未命名大屏' : '未命名页面'),
    artifactKind,
    targetProfile: targetProfileFor(artifactKind),
    status: 'completed',
    coverUrl: '',
    currentVersionLabel: null,
    currentRevisionId: null,
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
  const rt = mustRuntime(id)
  for (const t of rt.timers) clearTimeout(t)
  if (rt.autoTimer) clearTimeout(rt.autoTimer)
  sessions.delete(id)
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

export async function exportVersion(
  id: string,
  versionId: string
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  const rt = mustRuntime(id)
  const v = rt.s.versions.find((x) => x.id === versionId)
  if (!v) throw new HttpError(404, `版本不存在：${versionId}`)
  const adapter = artifactRegistry.get(v.manifest.kind)
  const filename = adapter.exportFileName(rt.s.dashboard.name, v.label)
  if (v.manifest.kind === 'business-app') {
    const draft = store.readArtifactDraft(id, versionId)
    if (!draft) throw new HttpError(404, '这个版本的业务应用源码找不到了，可能已被清理')
    return {
      filename,
      contentType: 'application/zip',
      body: await createBusinessAppSourceArchive(draft)
    }
  }
  const html = store.readPreview(id, versionId)
  if (html === null) throw new HttpError(404, '这个版本的页面文件找不到了，可能已被清理')
  // 下载单文件：把 data.json 内联进 HTML（保持自包含，脱离服务端仍能显示数据）
  const dataJson = store.readDataFileText(id, versionId)
  return {
    filename,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(inlineDataIntoHtml(html, dataJson), 'utf8')
  }
}

/* ============================== 初始数据（首次启动种入） ============================== */

const CLIENT_PREVIEW_DIR = path.resolve(process.cwd(), '../client/public/preview')

function seedVersion(rt: Runtime, label: string, summary: string, srcFile: string, published: boolean, isCurrent: boolean, createdAt: number): void {
  const id = `ver-seed-${rt.s.dashboard.id}-${label}`
  store.copyPreview(srcFile, rt.s.dashboard.id, id)
  const url = artifactPreviewUrl(rt.s.dashboard.id, id)
  rt.s.versions.push({
    id,
    label,
    summary,
    createdAt,
    screenshotUrl: rt.s.dashboard.coverUrl,
    published,
    isCurrent,
    manifest: manifestFor(rt.s.dashboard.artifactKind),
    validationReport: passedValidationReport('历史示例产物已按兼容规则登记')
  })
  rt.s.versionUrls[id] = url
  if (isCurrent) {
    rt.s.dashboard.currentVersionLabel = label
    rt.s.dashboard.currentRevisionId = id
    rt.s.preview = { state: 'ready', url }
  }
}

function seedDashboard(id: string, name: string, status: Dashboard['status'], coverUrl: string): Runtime {
  const now = Date.now()
  const dash: Dashboard = {
    id,
    name,
    artifactKind: 'dashboard',
    targetProfile: targetProfileFor('dashboard'),
    status,
    coverUrl,
    currentVersionLabel: null,
    currentRevisionId: null,
    updatedAt: now
  }
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
  skillRegistry.load()
  // 同步模板库（client/templates -> data/templates；源缺失时模板匹配自动降级）
  templatesRoot = syncTemplates(dirs.root)
  // 扫描模板 HTML 的 meta 标签构建内存目录（HTML 全文一并读入，供 Coder 注入）
  loadTemplateCatalog(templatesRoot)
  // 载入设置（normalizeSettings 兼容旧版 plannerModel 字符串字段）
  const s = store.loadSettings()
  if (s) cachedSettings = normalizeSettings({ ...DEFAULT_SETTINGS, ...s })
  // 载入 MCP 数据源列表
  cachedDataSources = normalizeDataSources(store.loadDataSources() ?? [])
  // 载入发布配置（云配置）
  const pc = store.loadPublishConfig()
  if (pc) cachedPublishConfig = normalizePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, ...pc })
  // 初始化 loop-adapter 的设置缓存（供执行器构造时使用）
  initAdapterSettings(cachedSettings, cachedDataSources, templatesRoot)
  // 种入示例大屏（仅首次）
  seedIfEmpty()
  // 恢复会话
  const dashboards = store.loadDashboards<Dashboard>() ?? []
  for (const dash of dashboards) {
    if (sessions.has(dash.id)) continue
    const session = store.loadSession<SessionData>(dash.id)
    if (session) makeRuntime(session)
    else makeRuntime(emptySession(dash))

    // 孤儿任务回收：上次进程在跑任务时被中断（重启/崩溃），引擎是内存态无法续跑。
    // 把残留的 generating 态降级为 idle，让前端回到"可输入"——用户重发消息即可触发新流程
    //（adapter.handleMessage 检查 engine=null 不会误排队，直接走 create/edit）。
    const rt = sessions.get(dash.id)
    if (rt && rt.s.runStatus === 'generating') {
      rt.s.runStatus = 'idle'
      rt.s.blocker = null
    }
  }
}
