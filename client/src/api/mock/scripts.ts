/**
 * ============================================================================
 * Mock 剧本 —— 演示的灵魂。所有"假后端"剧情都在这里按节奏发事件。
 *
 * 包含：
 *   1. 推荐规则表（C12，确定性代码，不随机）：buildProblemOptions
 *   2. 新建全流程：理解需求 → 澄清卡片 → 查找组件 → 编写页面 → 视觉检查
 *      → 3 个 Issue（2 个自动修好，第 3 个"表格超出边界"3 次失败进卡点）
 *      → 用户选"再试一次"修复成功 / 选"呼叫人工"走协助 → 生成预览 → v1
 *   3. 增量修改：修改 → 构建 → 检查 3 步（能耗大屏走"首次失败+10 秒倒计时自动重试"，
 *      门店经营看板走"停留超时（stall）卡点：比预期久了一点，仍在处理"）
 *   4. 回退 / 发布（5 秒审批通过）/ 人工协助（客服小李）/ 物流数据源卡点
 *
 * 所有函数只通过 Ctx 操作状态与发事件，由 engine.ts 提供实现。
 * ============================================================================
 */
import type {
  AgentStep,
  AssistSession,
  Blocker,
  CardOption,
  ChatMessage,
  ClarificationAnswer,
  ClarificationMessage,
  Issue,
  ProblemMessage,
  RunStatus,
  Stage,
  Version
} from '../../types'
import { nextId, previewUrl, type SessionState } from './data'

/* ============================== Ctx：engine 提供的能力 ============================== */

export interface Ctx {
  /** 当前大屏的完整 mock 状态 */
  s: SessionState
  /** 阶段槽位数（已出现过的最大阶段数；用于抹掉上一轮更长的方案尾巴） */
  stageSlots: number
  /** 排队消息（生成中用户追加的话） */
  queue: string[]

  /** 延时执行（group='assist' 可被 endAssist 整组取消） */
  after(ms: number, fn: () => void, group?: string): void
  clearGroup(group: string): void

  setStatus(status: RunStatus): void
  pushMessage(m: ChatMessage): void
  /** 就地修改过的消息重新推给 UI（同 id 替换；不改 state.messages，对象已在里面） */
  updateMessage(m: ChatMessage): void
  setStage(stage: Stage): void
  /** 新一轮开始：清空上一轮执行轨迹（下一个 step 事件自动带 reset） */
  resetSteps(): void
  /** 开始一个动作（阶段节点下的实时动作流） */
  startStep(stageId: string, title: string): AgentStep
  /** 结束一个动作：detail 为结果摘要（大白话）；failed 只用于导致卡点的真实失败 */
  finishStep(step: AgentStep, detail?: string | null, state?: AgentStep['state']): void
  setIssue(issue: Issue): void
  setBlocker(b: Blocker | null): void
  /** 新增版本（自动成为 current，旧的取消 current） */
  addVersion(v: Version, url: string): void
  /** 更新已有版本（如发布打 ★） */
  upsertVersion(v: Version): void
  previewReady(versionId: string, url: string): void
  updateDashboard(patch: Partial<SessionState['dashboard']>): void
  setAssist(a: AssistSession | null): void
  /** 倒计时自动执行：at 时刻若用户还没选，引擎会自动调 chooseOption(optionId) */
  setAutoExec(at: number, optionId: string): void
  clearAutoExec(): void
  /** 卡点解除后的续跑回调（同一时间最多一个） */
  setResume(fn: () => void): void
  takeResume(): (() => void) | null
  now(): number
}

/* ============================== 推荐规则表（C12，确定性） ============================== */

export type ProblemScenario = 'first_failure' | 'third_failure' | 'datasource_down' | 'high_risk'

export interface ProblemContext {
  hasVersion: boolean
  lastVersionLabel: string | null
}

/**
 * 推荐规则表（UX §4.3）：
 *   首次失败          → ★ 让 AI 再试一次（"同类问题自动修复成功率 90%+"，10 秒倒计时自动执行）
 *   同问题失败 3 次   → ★ 呼叫人工协助（"继续自动尝试成功率低，人工最快"）
 *   数据源不可用      → ★ 重新选择数据源（"不解决数据源，重试无意义"）
 *   高风险            → ★ 呼叫人工 / 转交审批（"高风险不允许自动绕过"，永不自动执行）
 * 恰好一个 ★推荐；回退/发布/权限类 autoExecuteAt 永远为 null。
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

  const compact = (arr: Array<CardOption | null>): CardOption[] => arr.filter((o): o is CardOption => o !== null)

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

/* ============================== 小工具 ============================== */

function truncate(text: string, max = 14): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function pushAgent(ctx: Ctx, text: string): void {
  ctx.pushMessage({ kind: 'agent', id: nextId('m'), createdAt: ctx.now(), text })
}

function pushSystem(ctx: Ctx, text: string): void {
  ctx.pushMessage({ kind: 'system', id: nextId('m'), createdAt: ctx.now(), text })
}

export function appendUserMessage(ctx: Ctx, text: string, attachments: string[], queued: boolean): void {
  ctx.pushMessage({ kind: 'user', id: nextId('m'), createdAt: ctx.now(), text, attachmentUrls: attachments, queued })
}

function coverFor(ctx: Ctx): string {
  return ctx.s.theme === 'k8s' ? '/covers/dash-k8s.png' : '/covers/dash-sales.png'
}

/* ============================== 阶段时间线 ============================== */

const CREATE_TITLES = ['理解需求', '查找组件', '编写页面', '视觉检查', '修复问题', '生成预览']
const CREATE_TITLES_WITH_IMAGE = ['分析参考图片', '查找组件', '编写页面', '视觉检查', '修复问题', '生成预览']
const EDIT_TITLES = ['修改', '构建', '检查']

/**
 * 发一整套阶段方案。槽位 id 固定为 st-1..st-N：
 * 新方案比上一轮短时，把多出来的旧槽位抹成空标题（store 只有 upsert 没有删除，
 * 这是契约内的最大努力；彻底方案见返回结果的集成建议）。
 */
function emitPlan(ctx: Ctx, titles: string[]): void {
  // 新一轮开始：清空上一轮的执行轨迹（下一个 startStep 事件带 reset，stores 同步清空）
  ctx.resetSteps()
  titles.forEach((t, i) => {
    ctx.setStage({
      id: `st-${i + 1}`,
      title: t,
      state: i === 0 ? 'active' : 'pending',
      startedAt: i === 0 ? ctx.now() : null,
      finishedAt: null
    })
  })
  for (let i = titles.length + 1; i <= ctx.stageSlots; i++) {
    ctx.setStage({ id: `st-${i}`, title: '', state: 'done', startedAt: null, finishedAt: null })
  }
  ctx.stageSlots = Math.max(ctx.stageSlots, titles.length)
}

function activateStage(ctx: Ctx, id: string): void {
  const st = ctx.s.stages.find((x) => x.id === id)
  if (!st || !st.title) return
  ctx.setStage({ ...st, state: 'active', startedAt: ctx.now(), finishedAt: null })
}

function finishStage(ctx: Ctx, id: string): void {
  const st = ctx.s.stages.find((x) => x.id === id)
  if (!st || !st.title) return
  ctx.setStage({ ...st, state: 'done', finishedAt: ctx.now() })
}

/* ============================== Issue ============================== */

const FIX_ISSUES = [
  { id: 'issue-chart', title: '图表不显示', fixDetail: '图表的数据来源名字写错了，已改正。' },
  { id: 'issue-color', title: '配色偏差', fixDetail: '柱状图颜色和深色背景太接近，已换成主题色。' },
  { id: 'issue-table', title: '表格超出边界', fixDetail: '表格列太宽，已改成自动换行并收窄。' }
]

function markFixed(ctx: Ctx, issueId: string): void {
  const issue = ctx.s.issues.find((i) => i.id === issueId)
  if (!issue) return
  const def = FIX_ISSUES.find((d) => d.id === issueId)
  ctx.setIssue({
    ...issue,
    status: 'fixed',
    afterShotUrl: ctx.s.dashboard.coverUrl || null,
    detail: def?.fixDetail ?? '已修好。'
  })
}

function bumpAttempt(ctx: Ctx, issueId: string, attempt: number, status: Issue['status']): void {
  const issue = ctx.s.issues.find((i) => i.id === issueId)
  if (!issue) return
  ctx.setIssue({ ...issue, attempt, status })
}

function latestFailedIssue(ctx: Ctx): Issue | null {
  const failed = ctx.s.issues.filter((i) => i.status === 'failed')
  return failed.length > 0 ? failed[failed.length - 1] : null
}

/* ============================== 卡点 ============================== */

interface BlockerSpec {
  scenario: ProblemScenario
  title: string
  description: string
  relatedIssueId: string | null
  /** 卡点解除后的续跑回调 */
  onResolved: () => void
}

function raiseBlocker(ctx: Ctx, spec: BlockerSpec): void {
  const options = buildProblemOptions(
    spec.scenario,
    { hasVersion: ctx.s.versions.length > 0, lastVersionLabel: ctx.s.versions[0]?.label ?? null },
    ctx.now()
  )
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: ctx.now(),
    title: spec.title,
    description: spec.description,
    options,
    chosenOptionId: null,
    relatedIssueId: spec.relatedIssueId
  }
  ctx.pushMessage(msg)
  const blockerType: Blocker['type'] =
    spec.scenario === 'datasource_down' ? 'external' : spec.scenario === 'first_failure' ? 'failed' : 'escalated'
  ctx.setBlocker({
    id: nextId('blk'),
    type: blockerType,
    title: spec.title,
    description: spec.description,
    options,
    relatedMessageId: msg.id
  })
  ctx.setStatus('blocked')
  ctx.setResume(spec.onResolved)
  ctx.updateDashboard({ status: 'needs_attention' })
  // 低风险重试类：10 秒倒计时自动执行（C11），用户随时可点别的选项打断
  const auto = options.find((o) => o.autoExecuteAt !== null)
  if (auto) ctx.setAutoExec(auto.autoExecuteAt as number, auto.id)
}

/**
 * 选择选项（问题处理卡片 / 右栏卡点行动区共用入口，两处等效）。
 * auto=true 表示倒计时到期自动执行。
 */
export function handleChooseOption(ctx: Ctx, optionId: string, auto = false): void {
  if (optionId === 'opt-goto-answer') return // "去回答"由 UI 本地滚动定位，不需要后端动作

  const prob = [...ctx.s.messages].reverse().find(
    (m): m is ProblemMessage => m.kind === 'problem' && m.chosenOptionId === null
  )
  const opt = prob?.options.find((o) => o.id === optionId) ?? ctx.s.blocker?.options.find((o) => o.id === optionId)
  if (!opt) return

  ctx.clearAutoExec()
  if (prob) {
    prob.chosenOptionId = optionId
    ctx.updateMessage(prob)
  }
  ctx.setBlocker(null)
  pushSystem(ctx, auto ? `已自动执行推荐方案：${opt.title}` : `你选择了：${opt.title}`)

  const resume = ctx.takeResume()
  switch (optionId) {
    case 'opt-wait':
      // 停留超时：继续等待 → 后台把当前这一步做完
      ctx.setStatus('generating')
      ctx.after(1500, () => resume?.())
      break
    case 'opt-retry-now': {
      // 停留超时：重试当前这一步（阶段重新计时）
      ctx.setStatus('generating')
      const st = ctx.s.stages.find((s) => s.state === 'active')
      if (st) ctx.setStage({ ...st, startedAt: ctx.now(), finishedAt: null })
      ctx.after(2000, () => resume?.())
      break
    }
    case 'opt-retry':
    case 'opt-retry-alt': {
      const issue = latestFailedIssue(ctx)
      ctx.setStatus('generating')
      if (issue) {
        ctx.setIssue({ ...issue, attempt: issue.attempt + 1, status: 'fixing' })
        const retryStep = ctx.startStep(issue.stageId, `再修一次（第 ${issue.attempt + 1} 次）：${issue.title}`)
        ctx.after(2400, () => {
          markFixed(ctx, issue.id)
          ctx.finishStep(retryStep, '修好了，复查通过')
          resume?.()
        })
      } else {
        ctx.after(1600, () => resume?.())
      }
      break
    }
    case 'opt-assist':
      if (resume) ctx.setResume(resume) // 协助修好后续跑
      startAssistFlow(ctx)
      break
    case 'opt-rollback': {
      const target = ctx.s.versions.find((v) => v.isCurrent) ?? ctx.s.versions[0]
      if (target) {
        doRollback(ctx, target.id)
        ctx.setStatus('idle')
        ctx.updateDashboard({ status: 'completed' })
      } else {
        resume?.()
      }
      break
    }
    case 'opt-reselect-datasource':
      pushAgent(ctx, '好的，已切换到备用数据源（公司车辆平台），继续生成…')
      ctx.setStatus('generating')
      ctx.after(1500, () => resume?.())
      break
    default:
      resume?.()
  }
}

/**
 * 停留超时（stall）卡点（UX §5.4）："比预期久了一点，仍在处理" + [继续等待] [重试]。
 * 用户不动手时后台会自己做完，卡点自动解除（等效于选了「继续等待」）。
 */
function raiseStallBlocker(ctx: Ctx, onResolved: () => void): void {
  const options: CardOption[] = [
    {
      id: 'opt-wait',
      title: '继续等待',
      consequence: '后台还在正常推进，通常再等一会儿就好',
      recommended: true,
      recommendReason: '只是慢，不是卡死',
      riskLevel: 'low',
      autoExecuteAt: null
    },
    {
      id: 'opt-retry-now',
      title: '重试这一步',
      consequence: '重新做当前这一步，大约 1 分钟',
      recommended: false,
      recommendReason: null,
      riskLevel: 'low',
      autoExecuteAt: null
    }
  ]
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: ctx.now(),
    title: '比预期久了一点，仍在处理',
    description: '当前这一步比平时慢，后台还在继续，没有卡死。',
    options,
    chosenOptionId: null,
    relatedIssueId: null
  }
  ctx.pushMessage(msg)
  const blockerId = nextId('blk')
  ctx.setBlocker({
    id: blockerId,
    type: 'stall',
    title: '比预期久了一点，仍在处理',
    description: '当前这一步比平时慢，后台还在继续。可以继续等，也可以重试这一步。',
    options,
    relatedMessageId: msg.id
  })
  ctx.setStatus('blocked')
  ctx.setResume(onResolved)
  ctx.updateDashboard({ status: 'needs_attention' })
  // 9 秒后用户还没动手：后台自己做完了，卡点自动解除
  ctx.after(9000, () => {
    if (ctx.s.blocker?.id !== blockerId) return
    if (msg.chosenOptionId === null) {
      msg.chosenOptionId = 'opt-wait'
      ctx.updateMessage(msg)
    }
    ctx.setBlocker(null)
    pushSystem(ctx, '刚才只是慢了一点，已经继续完成了')
    ctx.setStatus('generating')
    const resume = ctx.takeResume()
    ctx.after(1500, () => resume?.())
  })
}

/* ============================== F1 新建全流程 ============================== */

function opt(
  id: string,
  title: string,
  consequence: string,
  recommended = false,
  recommendReason: string | null = null
): CardOption {
  return { id, title, consequence, recommended, recommendReason, riskLevel: 'low', autoExecuteAt: null }
}

/** 默认（服务器监控类）澄清卡片 */
function buildClarificationDefault(ctx: Ctx): ClarificationMessage {
  return {
    kind: 'clarification',
    id: nextId('m'),
    createdAt: ctx.now(),
    intro: '开始之前，想跟你确认两件事',
    answered: false,
    questions: [
      {
        id: 'q-metrics',
        question: '监控哪些指标？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-metrics-a', 'CPU / 内存 / 网络', '最常用的三样，一块屏全看到', true, '最常用组合，一次到位'),
          opt('q-metrics-b', '只要 CPU 和内存', '界面更简洁，网络指标不展示')
        ]
      },
      {
        id: 'q-refresh',
        question: '数据多久自动刷新一次？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-refresh-a', '每 5 秒', '接近实时，适合盯告警', true, '监控场景选得最多'),
          opt('q-refresh-b', '每分钟', '更省资源，适合长期挂屏')
        ]
      }
    ]
  }
}

/** 发了参考图片时：先"分析图片"，再按图片内容确认（不再是固定问题） */
function buildClarificationForImage(ctx: Ctx): ClarificationMessage {
  return {
    kind: 'clarification',
    id: nextId('m'),
    createdAt: ctx.now(),
    intro: '图片分析完了，开始之前再跟你确认两件事',
    answered: false,
    questions: [
      {
        id: 'q-hero',
        question: '中间的主视觉区想放什么？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-hero-a', '和图片一样放地图', '还原度最高，做出来最接近参考图', true, '参考图的主视觉就是地图，照着做最不容易走样'),
          opt('q-hero-b', '换成核心指标大图', '突出几个关键数字，不放地图')
        ]
      },
      {
        id: 'q-panels',
        question: '图片两侧的面板要保留哪些？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-panels-a', '排行榜和指标卡都保留', '和图片结构一致，信息更全', true, '与参考图结构一致，一次到位'),
          opt('q-panels-b', '只要指标卡', '界面更清爽，排行榜不做')
        ]
      }
    ]
  }
}

/** 销售/营收类需求的澄清卡片 */
function buildClarificationForSales(ctx: Ctx): ClarificationMessage {
  return {
    kind: 'clarification',
    id: nextId('m'),
    createdAt: ctx.now(),
    intro: '开始之前，想跟你确认两件事',
    answered: false,
    questions: [
      {
        id: 'q-sales-data',
        question: '重点看哪些销售数据？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-sales-data-a', '销售额 + 订单量 + 达成率', '日报最常看的三样，一屏看全', true, '销售场景选得最多的组合'),
          opt('q-sales-data-b', '再加上区域对比', '多一块地图/排行，看各区域卖得怎么样')
        ]
      },
      {
        id: 'q-sales-refresh',
        question: '数据多久自动刷新一次？',
        allowCustomInput: true,
        answer: null,
        options: [
          opt('q-sales-refresh-a', '每小时', '销售数据不用秒级，稳定又省资源', true, '日报场景最合适的频率'),
          opt('q-sales-refresh-b', '每分钟', '更接近实时，适合大促盯盘')
        ]
      }
    ]
  }
}

/** 按用户输入（文字关键词 / 是否带图）挑选对应的澄清卡片，不再是固定一套问题 */
function buildClarification(ctx: Ctx, userText: string, hasImage: boolean): ClarificationMessage {
  if (hasImage) return buildClarificationForImage(ctx)
  if (/销售|营收|订单|业绩|门店/.test(userText)) return buildClarificationForSales(ctx)
  return buildClarificationDefault(ctx)
}

/** 新建大屏全流程（用户在空工作台发出第一条消息时启动；带参考图时先"分析图片"再确认问题） */
export function startCreateFlow(ctx: Ctx, userText: string, hasImage = false): void {
  emitPlan(ctx, hasImage ? CREATE_TITLES_WITH_IMAGE : CREATE_TITLES)
  ctx.setStatus('generating')
  ctx.updateDashboard({ status: 'generating' })
  pushAgent(
    ctx,
    hasImage ? '好的，我先仔细看看你发来的图片…' : '好的，我来帮你做。先理解一下你的需求…'
  )
  const planStep = ctx.startStep('st-1', hasImage ? '分析你的需求和参考图' : '分析你的需求')
  ctx.after(hasImage ? 2800 : 2000, () => {
    const askClarification = (): void => {
      const card = buildClarification(ctx, userText, hasImage)
      ctx.pushMessage(card)
      ctx.setStatus('awaiting_clarification')
      ctx.setBlocker({
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
      ctx.setResume(() => continueCreateAfterClarification(ctx))
    }
    if (hasImage) {
      // 先精读参考图给出"图片分析结论"，再据此确认问题（UX §4.2：过程永远可见）
      ctx.finishStep(planStep, '需求清楚了')
      const invStep = ctx.startStep('st-1', '精读参考图：裁出 5 块局部放大')
      ctx.after(1800, () => {
        ctx.finishStep(invStep, '认出了 6 个面板、4 个指标')
        finishStage(ctx, 'st-1')
        pushAgent(
          ctx,
          '图片分析完了：整体是深色科技风，中间是主视觉区，两侧排着指标卡和排行榜。我按这个骨架来做。'
        )
        askClarification()
      })
    } else {
      ctx.finishStep(planStep, '还有几个细节要跟你确认')
      finishStage(ctx, 'st-1')
      askClarification()
    }
  })
}

function continueCreateAfterClarification(ctx: Ctx): void {
  ctx.setStatus('generating')
  pushAgent(ctx, '好的，就按你选的来做，马上开始。')
  activateStage(ctx, 'st-2')
  const matchStep = ctx.startStep('st-2', '和模板库比对：6 种布局、12 类组件')
  ctx.after(2000, () => {
    ctx.finishStep(matchStep, '命中「指挥中心三栏」、指标卡、排名条')
    finishStage(ctx, 'st-2')
    activateStage(ctx, 'st-3')
    const codeStep = ctx.startStep('st-3', '编写页面')
    ctx.after(2500, () => {
      ctx.finishStep(codeStep, '写完了，共 4,213 字')
      finishStage(ctx, 'st-3')
      activateStage(ctx, 'st-4')
      const shotStep = ctx.startStep('st-4', '给页面截图')
      ctx.after(1000, () => {
        ctx.finishStep(shotStep, '截图好了')
        const reviewStep = ctx.startStep('st-4', '拿着截图逐项检查')
        ctx.after(1000, () => {
          ctx.finishStep(reviewStep, '发现 3 个问题')
          finishStage(ctx, 'st-4')
          runFixPhase(ctx, () => finishCreate(ctx))
        })
      })
    })
  })
}

/** dash-k8s 预置在"视觉检查"进行中，进入工作台后从这里续跑 */
export function resumeCreateAtCheck(ctx: Ctx): void {
  ctx.after(1500, () => {
    const shot = ctx.s.steps.find((x) => x.id === 'step-k8s-4')
    if (shot && shot.state === 'active') ctx.finishStep(shot, '截图好了')
    const reviewStep = ctx.startStep('st-4', '拿着截图逐项检查')
    ctx.after(1000, () => {
      ctx.finishStep(reviewStep, '发现 3 个问题')
      finishStage(ctx, 'st-4')
      runFixPhase(ctx, () => finishCreate(ctx))
    })
  })
}

/** 视觉检查发现 3 个 Issue：前 2 个自动修好，第 3 个 3 次失败后进卡点 */
function runFixPhase(ctx: Ctx, next: () => void): void {
  activateStage(ctx, 'st-5')
  pushAgent(ctx, '检查发现 3 个小问题，正在挨个自动修复…')
  FIX_ISSUES.forEach((def) => {
    ctx.setIssue({
      id: def.id,
      stageId: 'st-5',
      title: def.title,
      attempt: 1,
      status: 'fixing',
      beforeShotUrl: ctx.s.dashboard.coverUrl || null,
      afterShotUrl: null,
      detail: ''
    })
  })
  const fix1 = ctx.startStep('st-5', '修复 3 个问题（第 1 次）')
  let fix2: AgentStep | null = null
  let fix3: AgentStep | null = null
  ctx.after(1800, () => markFixed(ctx, 'issue-chart'))
  ctx.after(3600, () => markFixed(ctx, 'issue-color'))
  ctx.after(5400, () => {
    bumpAttempt(ctx, 'issue-table', 1, 'failed')
    ctx.finishStep(fix1, '修好了 2 个，「表格超出边界」没修好')
    fix2 = ctx.startStep('st-5', '再修一次（第 2 次）：表格超出边界')
  })
  ctx.after(7200, () => bumpAttempt(ctx, 'issue-table', 2, 'fixing'))
  ctx.after(9000, () => {
    bumpAttempt(ctx, 'issue-table', 2, 'failed')
    if (fix2) ctx.finishStep(fix2, '还是没修好', 'failed')
    fix3 = ctx.startStep('st-5', '再修一次（第 3 次）：表格超出边界')
  })
  ctx.after(10800, () => bumpAttempt(ctx, 'issue-table', 3, 'fixing'))
  ctx.after(12600, () => {
    bumpAttempt(ctx, 'issue-table', 3, 'failed')
    if (fix3) ctx.finishStep(fix3, '还是没修好', 'failed')
    raiseBlocker(ctx, {
      scenario: 'third_failure',
      title: '自动修复没有成功',
      description: '「表格超出边界」已经尝试了 3 次，仍没修好。',
      relatedIssueId: 'issue-table',
      onResolved: next
    })
  })
}

/** 收尾：生成预览 → v1 → 空闲 */
function finishCreate(ctx: Ctx): void {
  finishStage(ctx, 'st-5')
  activateStage(ctx, 'st-6')
  const commitStep = ctx.startStep('st-6', '生成预览，存成新版本')
  ctx.after(2200, () => {
    commitVersion(ctx, '初版完成', 1)
    ctx.finishStep(commitStep, '新版本可以看了')
    finishStage(ctx, 'st-6')
    pushAgent(ctx, '你的大屏做好了！右侧预览可以看看效果，想改哪里直接跟我说。')
    defaultComplete(ctx)
  })
}

/* ============================== F2 增量修改（精简 3 步） ============================== */

export type EditVariant = 'smooth' | 'retry_once' | 'stall'

export function startIncrementalFlow(ctx: Ctx, text: string, variant: EditVariant): void {
  emitPlan(ctx, EDIT_TITLES)
  ctx.setStatus('generating')
  ctx.updateDashboard({ status: 'generating' })
  pushAgent(
    ctx,
    text.trim()
      ? `收到，我来调整：「${truncate(text)}」，涉及 1 处修改。`
      : '收到，我按你发来的图片做参考来调整，涉及 1 处修改。'
  )
  const editStep = ctx.startStep('st-1', '修改页面')
  ctx.after(1800, () => {
    ctx.finishStep(editStep, '改完了')
    finishStage(ctx, 'st-1')
    activateStage(ctx, 'st-2')
    ctx.after(2000, () => {
      finishStage(ctx, 'st-2')
      activateStage(ctx, 'st-3')
      const checkStep = ctx.startStep('st-3', '拿着截图逐项检查')
      if (variant === 'retry_once') {
        // 首次失败 → ★重试 + 10 秒倒计时自动执行（C11 演示）
        ctx.after(1500, () => {
          ctx.finishStep(checkStep, '发现 1 个问题')
          ctx.setIssue({
            id: 'issue-overlap',
            stageId: 'st-3',
            title: '数据标签重叠',
            attempt: 1,
            status: 'fixing',
            beforeShotUrl: ctx.s.dashboard.coverUrl || null,
            afterShotUrl: null,
            detail: ''
          })
          const fixStep = ctx.startStep('st-3', '修复 1 个问题（第 1 次）：数据标签重叠')
          ctx.after(1800, () => {
            bumpAttempt(ctx, 'issue-overlap', 1, 'failed')
            ctx.finishStep(fixStep, '还是没修好', 'failed')
            raiseBlocker(ctx, {
              scenario: 'first_failure',
              title: '检查时出了点小问题',
              description: '「数据标签重叠」自动修复没有成功，这是第 1 次尝试。',
              relatedIssueId: 'issue-overlap',
              onResolved: () => finishIncremental(ctx, text)
            })
          })
        })
      } else if (variant === 'stall') {
        // 停留超时（stall）演示：检查这一步比平时久 → 弹「比预期久了一点，仍在处理」卡点
        ctx.after(5000, () =>
          raiseStallBlocker(ctx, () => {
            ctx.finishStep(checkStep, '没发现问题')
            finishIncremental(ctx, text)
          })
        )
      } else {
        ctx.after(1800, () => {
          ctx.finishStep(checkStep, '没发现问题')
          finishIncremental(ctx, text)
        })
      }
    })
  })
}

function finishIncremental(ctx: Ctx, text: string): void {
  finishStage(ctx, 'st-3')
  commitVersion(ctx, truncate(text), pickVariant(ctx))
  pushAgent(ctx, '改好了，看看效果～想继续调整随时说。')
  defaultComplete(ctx)
}

/** v1 用基础版预览，之后偶数版用放大版，保证 v1→v2 有肉眼可见差异 */
function pickVariant(ctx: Ctx): 1 | 2 {
  return (ctx.s.versions.length + 1) % 2 === 0 ? 2 : 1
}

function commitVersion(ctx: Ctx, summary: string, variant: 1 | 2): void {
  const n = ctx.s.versions.length + 1
  const url = previewUrl(ctx.s.theme, variant, ctx.s.dashboard.name, n)
  const v: Version = {
    id: nextId('ver'),
    label: `v${n}`,
    summary,
    createdAt: ctx.now(),
    screenshotUrl: ctx.s.dashboard.coverUrl,
    published: false,
    isCurrent: true
  }
  ctx.addVersion(v, url)
  ctx.previewReady(v.id, url)
}

function defaultComplete(ctx: Ctx): void {
  ctx.setStatus('idle')
  ctx.updateDashboard({ status: 'completed', coverUrl: coverFor(ctx) })
  drainQueue(ctx)
}

/** 生成中排队的话，空闲后合并成一次增量修改处理掉 */
export function drainQueue(ctx: Ctx): void {
  if (ctx.s.runStatus !== 'idle' || ctx.queue.length === 0) return
  const text = ctx.queue.splice(0, ctx.queue.length).join('；')
  // 排队的话开始处理了：摘掉"排队中"标记（消息小字与输入框上方提示条随之消失）
  for (const m of ctx.s.messages) {
    if (m.kind === 'user' && m.queued) {
      m.queued = false
      ctx.updateMessage(m)
    }
  }
  startIncrementalFlow(ctx, text, 'smooth')
}

/* ============================== 澄清回答 ============================== */

export function handleAnswerClarification(ctx: Ctx, messageId: string, answers: ClarificationAnswer[]): void {
  if (ctx.s.runStatus !== 'awaiting_clarification') return
  const m = ctx.s.messages.find((x) => x.id === messageId)
  if (m?.kind === 'clarification') {
    for (const a of answers) {
      const q = m.questions.find((qq) => qq.id === a.questionId)
      if (q) q.answer = a.customText || q.options.find((o) => o.id === a.optionId)?.title || ''
    }
    m.answered = true
  }
  ctx.setBlocker(null)
  ctx.takeResume()?.()
}

/** 等待澄清时用户直接打字（视为自由回答，UX §4.3 兜底入口） */
export function resolveClarificationWithText(ctx: Ctx, text: string): void {
  const m = [...ctx.s.messages].reverse().find((x): x is ClarificationMessage => x.kind === 'clarification' && !x.answered)
  if (m) {
    m.questions.forEach((q) => {
      if (!q.answer) q.answer = text
    })
    m.answered = true
    ctx.updateMessage(m)
  }
  ctx.setBlocker(null)
  pushAgent(ctx, '好的，就按你说的来。')
  ctx.takeResume()?.()
}

/** 卡点时用户直接打字（视为"再试一次"，UX §4.3 第 4 种选项） */
export function handleFreeTextDuringBlocked(ctx: Ctx, _text: string): void {
  ctx.clearAutoExec()
  const prob = [...ctx.s.messages].reverse().find(
    (m): m is ProblemMessage => m.kind === 'problem' && m.chosenOptionId === null
  )
  if (prob) {
    prob.chosenOptionId = 'free-text'
    ctx.updateMessage(prob)
  }
  ctx.setBlocker(null)
  pushAgent(ctx, '好的，按你的想法再试一次。')
  const resume = ctx.takeResume()
  const issue = latestFailedIssue(ctx)
  ctx.setStatus('generating')
  if (issue) {
    ctx.setIssue({ ...issue, attempt: issue.attempt + 1, status: 'fixing' })
    const retryStep = ctx.startStep(issue.stageId, `再修一次（第 ${issue.attempt + 1} 次）：${issue.title}`)
    ctx.after(2400, () => {
      markFixed(ctx, issue.id)
      ctx.finishStep(retryStep, '修好了，复查通过')
      resume?.()
    })
  } else {
    ctx.after(1600, () => {
      if (resume) resume()
      else ctx.setStatus('idle')
    })
  }
}

/* ============================== F3 回退 ============================== */

export function doRollback(ctx: Ctx, versionId: string): void {
  const target = ctx.s.versions.find((v) => v.id === versionId)
  if (!target) return
  const url = ctx.s.versionUrls.get(versionId) ?? ctx.s.preview.url ?? ''
  const n = ctx.s.versions.length + 1
  const v: Version = {
    id: nextId('ver'),
    label: `v${n}`,
    summary: `回退到 ${target.label}`,
    createdAt: ctx.now(),
    screenshotUrl: target.screenshotUrl,
    published: false,
    isCurrent: true
  }
  ctx.addVersion(v, url)
  ctx.previewReady(v.id, url)
  pushSystem(ctx, `已回退到 ${target.label} 版本（${target.label} 之后的记录都还在，随时可以回来）`)
  ctx.updateDashboard({})
}

/* ============================== F6 发布（非管理员 = 提交申请） ============================== */

export function startPublishFlow(ctx: Ctx): void {
  // 已在等待审批时重复提交：忽略（界面按钮也会置灰，这里是兜底）
  if (ctx.s.stages.some((s) => s.id === 'st-publish' && s.state === 'active')) return
  pushAgent(ctx, '已提交发布申请，正在等待审批。通过后会第一时间告诉你。')
  // 执行面板显示「等待审批」阶段（UX §5.6），通过后会打勾
  ctx.setStage({ id: 'st-publish', title: '等待审批', state: 'active', startedAt: ctx.now(), finishedAt: null })
  ctx.after(5000, () => {
    const cur = ctx.s.versions.find((v) => v.isCurrent)
    if (cur) ctx.upsertVersion({ ...cur, published: true })
    const st = ctx.s.stages.find((s) => s.id === 'st-publish')
    if (st) ctx.setStage({ ...st, state: 'done', finishedAt: ctx.now() })
    pushAgent(ctx, '好消息！发布申请已通过，大屏正式发布了。')
    ctx.updateDashboard({ status: 'published' })
  })
}

/* ============================== F5 人工协助 ============================== */

function pushAction(ctx: Ctx, text: string): void {
  const cur = ctx.s.assistSession
  if (!cur) return
  ctx.setAssist({ ...cur, actions: [...cur.actions, { at: ctx.now(), text }] })
}

function endAssistQuiet(ctx: Ctx, summary: string): void {
  ctx.clearGroup('assist')
  ctx.setAssist(null)
  pushSystem(ctx, summary)
  if (ctx.s.runStatus === 'assisting') ctx.setStatus('idle')
  drainQueue(ctx)
}

export function startAssistFlow(ctx: Ctx, note?: string): void {
  if (ctx.s.runStatus === 'assisting') return
  ctx.clearAutoExec()
  ctx.setBlocker(null)
  ctx.setStatus('assisting')
  pushSystem(ctx, '已通知支持人员，预计 5 分钟内响应，你可以先做别的')
  ctx.after(
    3000,
    () => {
      const t0 = ctx.now()
      ctx.setAssist({ operatorName: '小李', startedAt: t0, actions: [{ at: t0, text: '小李已接入，正在查看执行过程…' }] })
      pushSystem(ctx, '支持人员小李已接入')
      ctx.after(
        2200,
        () => {
          pushAction(ctx, note ? `看了你的留言：「${truncate(note, 20)}」` : '查看了最近的执行记录')
          ctx.after(
            2400,
            () => {
              const failed = latestFailedIssue(ctx)
              const resume = ctx.takeResume()
              if (failed) {
                // 卡点场景：客服帮你修好，流程继续出预览
                pushAction(ctx, `帮你重试了「${failed.title}」✓ 已修好`)
                markFixed(ctx, failed.id)
                ctx.after(
                  1800,
                  () => {
                    pushAction(ctx, '问题已解决，把控制权交还给你')
                    resume?.()
                    ctx.after(3000, () => endAssistQuiet(ctx, `协助结束：小李帮你修好了「${failed.title}」。`), 'assist')
                  },
                  'assist'
                )
              } else if (resume) {
                // 物流数据源场景：客服帮你切备用通道
                pushAction(ctx, '帮你把数据源切到了备用通道 ✓')
                ctx.after(
                  1800,
                  () => {
                    resume()
                    ctx.after(3000, () => endAssistQuiet(ctx, '协助结束：小李帮你把数据源切到了备用通道。'), 'assist')
                  },
                  'assist'
                )
              } else {
                // 无事求助：看一圈，报平安
                pushAction(ctx, '没有发现需要处理的问题，随时再叫我')
                ctx.after(1800, () => endAssistQuiet(ctx, '协助结束：小李检查了一遍，没有发现需要处理的问题。'), 'assist')
              }
            },
            'assist'
          )
        },
        'assist'
      )
    },
    'assist'
  )
}

/** 用户主动结束协助：取消协助组的后续动作，收回控制权 */
export function endAssistFlow(ctx: Ctx): void {
  if (!ctx.s.assistSession) return
  endAssistQuiet(ctx, '你已结束协助，控制权已收回。')
}

/* ============================== 物流数据源卡点（seed 挂载） ============================== */

/** engine 初始化时调用：给 dash-logistics 挂上"数据源不可用"卡点（选项走规则表） */
export function attachLogisticsBlocker(ctx: Ctx): void {
  const options = buildProblemOptions('datasource_down', { hasVersion: true, lastVersionLabel: 'v1' }, ctx.now())
  const msg: ProblemMessage = {
    kind: 'problem',
    id: nextId('m'),
    createdAt: ctx.now(),
    title: '连不上车辆定位数据源',
    description: '车辆定位数据源没有响应，地图上的实时位置画不出来。',
    options,
    chosenOptionId: null,
    relatedIssueId: null
  }
  ctx.pushMessage(msg)
  ctx.setBlocker({
    id: nextId('blk'),
    type: 'external',
    title: '数据源连不上',
    description: '车辆定位数据源没有响应，需要换一个数据源才能继续。',
    options,
    relatedMessageId: msg.id
  })
  ctx.setResume(() => completeLogisticsFix(ctx))
}

function completeLogisticsFix(ctx: Ctx): void {
  emitPlan(ctx, EDIT_TITLES)
  ctx.after(1600, () => {
    finishStage(ctx, 'st-1')
    activateStage(ctx, 'st-2')
    ctx.after(1800, () => {
      finishStage(ctx, 'st-2')
      activateStage(ctx, 'st-3')
      ctx.after(1600, () => {
        finishStage(ctx, 'st-3')
        commitVersion(ctx, '接入备用数据源', 2)
        pushAgent(ctx, '车辆实时位置已经出来了，看看效果～')
        defaultComplete(ctx)
      })
    })
  })
}
