/**
 * DashboardLoopAdapter -- 大屏业务实例 + 适配层。
 *
 * 持有 LoopEngine 实例，把用户操作转成 LoopEvent 传给引擎，
 * 引擎自动决定 start/resume/restore。业务只声明"步骤+关系+怎么存"。
 *
 * 替代 orchestrator 的 handleSendMessage/handleAnswerClarification/
 * handleChooseOption/handleRollback 四个入口函数。
 */
import type { LoopEngine, GraphState, NodeId, NodeExecutor, FlowDefinition } from '../../../loop-engine/src'
import { createLoop } from '../../../loop-engine/src'
import { store } from '../store'
import * as gw from '../gateway'
import * as mcp from '../mcp'
import { prompt } from '../prompts'
import { syncAdapterSession, syncAdapterDashboard, getCapability } from '../orchestrator'
import {
  syncTemplates,
  loadTemplateCatalog,
  catalogText,
  keywordHint,
  findTemplate,
  templatesByType,
  templateImageDataUrl
} from '../templates'
import { probeReplicaEnv, imageSize, cropImageDataUrl, renderShotDataUrl, fetchGeoJson, geojsonToSvgPaths } from '../replica'
import type {
  ModelSettings,
  McpDataSource,
  Dashboard,
  Version,
  ChatMessage,
  Stage,
  RunStatus,
  Blocker,
  CardOption,
  ClarificationMessage,
  ClarificationAnswer,
  ProblemMessage,
  Issue,
  DataUseEntry,
  GraphSnapshot,
  GraphNodeSnapshot
} from '../wire'
import { CREATE_NODES, EDIT_NODES, SUSPEND_TAGS, selectCreateFlow, createResumeTable, editResumeTable, editFlow } from './flow-definition'
import type { LlmAdapter, McpAdapter, StorageAdapter, TemplateAdapter } from './executor-types'
import { PlannerExecutor } from './executors/planner'
import { MatchExecutor } from './executors/match'
import { FetchExecutor } from './executors/fetch'
import { CoderExecutor } from './executors/coder'
import { CheckExecutor } from './executors/check'
import { RepairExecutor } from './executors/repair'
import { FinishExecutor } from './executors/finish'
import { coverFor, truncate, buildDataBlockFromItems } from './shared-utils'
import type { DashboardDataItem } from './shared-utils'

/* ============================== 适配器实现 ============================== */

/** 全局设置缓存（与 orchestrator 共享） */
let cachedSettings: ModelSettings
let cachedDataSources: McpDataSource[] = []
let templatesRoot: string | null = null

/** 每个大屏一个 adapter 实例 */
const adapters = new Map<string, DashboardLoopAdapter>()

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** LLM 适配器：包装 gateway */
function makeLlmAdapter(): LlmAdapter {
  return {
    async chatStream(role, messages, onProgress, opts) {
      return gw.chatCompletionStream(
        cachedSettings,
        { role, messages: messages as gw.LlmMessage[], maxTokens: opts?.maxTokens, signal: opts?.signal },
        onProgress
      )
    },
    extractJson(text) { return gw.extractJson(text) },
    extractHtml(text) { return gw.extractHtml(text) }
  }
}

/** MCP 适配器：包装 mcp 模块 */
function makeMcpAdapter(): McpAdapter {
  return {
    async listTools(source) { return mcp.listTools(source) },
    async callTool(source, tool, args) { return mcp.callTool(source, tool, args) }
  }
}

/** 存储适配器：包装 store */
function makeStorageAdapter(): StorageAdapter {
  return {
    writePreview: (dashId, verId, html) => store.writePreview(dashId, verId, html),
    readPreview: (dashId, verId) => store.readPreview(dashId, verId),
    writeVersionMeta: (dashId, verId, meta) => store.writeVersionMeta(dashId, verId, meta),
    readVersionMeta: (dashId, verId) => store.readVersionMeta(dashId, verId),
    writeDataFile: (dashId, verId, data) => store.writeDataFile(dashId, verId, data),
    readDataFile: (dashId, verId) => store.readDataFile(dashId, verId),
    readDataFileText: (dashId, verId) => store.readDataFileText(dashId, verId),
    writeShot: (dashId, name, dataUrl) => store.writeShot(dashId, name, dataUrl),
    emit: (dashId, type, payload) => store.emit(dashId, type as never, payload as never),
    saveSession: (dashId, session) => store.saveSession(dashId, session),
    loadSession: (dashId) => store.loadSession(dashId)
  }
}

/** 模板适配器：包装 templates 模块 */
function makeTemplateAdapter(): TemplateAdapter {
  return {
    catalogText: () => catalogText(),
    keywordHint: (text) => keywordHint(text),
    findTemplate: (id) => {
      const t = findTemplate(id)
      return t ? { html: t.html, image: t.image, name: t.name } : undefined
    },
    templatesByType: (type) =>
      templatesByType(type).map((t) => ({
        id: t.id, name: t.name, html: t.html, image: t.image,
        tags: t.tags, dataKind: t.dataKind, slot: t.slot, description: t.description
      })),
    templateImageDataUrl: (root, relPath) =>
      templatesRoot ? templateImageDataUrl(templatesRoot, relPath) : null
  }
}

/* ============================== DashboardLoopAdapter ============================== */

export class DashboardLoopAdapter {
  private dashId: string
  private engine: LoopEngine | null = null
  private llm: LlmAdapter
  private mcpAdapter: McpAdapter
  private storage: StorageAdapter
  private templateAdapter: TemplateAdapter
  /** 当前运行态产物（HTML），commit 时存进版本 */
  private currentHtml: string = ''
  /** edit 流程从源版本 data.json 回填的真实数据（结构化数组），commit 时写进新版本目录。
   *  edit 图无 fetch 节点，靠这个把数据上下文传给 coder/repair + 落盘新版本。 */
  private editDataFile: unknown[] | null = null
  /** edit 流程从源版本 data.json 回填的 dataBlock 文本（给 coder/repair LLM 看数据形状） */
  private editDataBlock: string = ''
  /** 用户需求文本（start 前设置） */
  private pendingText: string = ''
  private pendingAttachments: string[] = []
  /** 排队消息 */
  private queue: Array<{ text: string; attachments: string[] }> = []
  /** 当前澄清卡片 id */
  private clarificationMessageId: string | null = null
  /** 最近一次流程图快照（每次 emitGraphState 缓存，供 enterDashboard 刷新恢复） */
  private lastGraph: GraphSnapshot | null = null
  /** session 持久化状态（messages/stages/versions 等，与前端契约对齐） */
  private session: {
    messages: ChatMessage[]
    stages: Stage[]
    versions: Version[]
    versionUrls: Record<string, string>
    runStatus: RunStatus
    blocker: Blocker | null
    preview: { state: 'empty' | 'building' | 'ready'; url: string | null }
    graph: GraphSnapshot | null
  }

  constructor(dashId: string) {
    this.dashId = dashId
    this.llm = makeLlmAdapter()
    this.mcpAdapter = makeMcpAdapter()
    this.storage = makeStorageAdapter()
    this.templateAdapter = makeTemplateAdapter()
    // 从磁盘恢复 session（如有）
    const existing = this.storage.loadSession<typeof this.session>(dashId)
    this.session = existing ?? {
      messages: [], stages: [], versions: [], versionUrls: {},
      runStatus: 'idle', blocker: null, preview: { state: 'empty', url: null }, graph: null
    }
    // 恢复 lastGraph（供后续 emitGraphState 增量更新）
    this.lastGraph = this.session.graph ?? null
  }

  /** 持久化 session 到磁盘 + 同步到 orchestrator Runtime（供前端 enterDashboard 读） */
  private save(): void {
    this.storage.saveSession(this.dashId, this.session)
    // 同步到 orchestrator 的内存 Runtime，让 enterDashboard/snapshotOf 能读到最新状态
    syncAdapterSession(this.dashId, {
      messages: this.session.messages,
      stages: this.session.stages,
      versions: this.session.versions,
      versionUrls: this.session.versionUrls,
      runStatus: this.session.runStatus,
      blocker: this.session.blocker,
      preview: this.session.preview,
      graph: this.session.graph
    })
  }

  /* ---------- 引擎创建 ---------- */

  /** 创建 create 流程引擎 */
  private async createCreateEngine(hasImage: boolean, inputText?: string, inputAttachments?: string[]): Promise<LoopEngine> {
    // visionOk（给 planner/match/coder）：用户发了参考图才有图可附，hasImage 语义正确
    const visionOk = hasImage
    // check 节点的截图审查能力：模型支持视觉 + 截图浏览器可用，与 hasImage 无关
    // （即使纯文字建大屏，只要模型能看图，check 就该截图审查而非只读源码）
    const cap = await getCapability()
    const checkVision = cap.ok && cap.supportsVision
    const hasDs = cachedDataSources.some((s) => s.enabled && s.url)
    const definition = selectCreateFlow(hasDs)
    const resume = createResumeTable(hasDs)

    const executors: Record<string, NodeExecutor> = {
      [CREATE_NODES.planner]: new PlannerExecutor({ llm: this.llm, visionOk, replica: { probeReplicaEnv, imageSize, cropImageDataUrl }, inputText: inputText ?? '', inputAttachments: inputAttachments ?? [] }),
      [CREATE_NODES.match]: new MatchExecutor({ llm: this.llm, templates: this.templateAdapter, templatesRoot: templatesRoot ?? '', visionOk }),
      [CREATE_NODES.fetch]: new FetchExecutor(this.llm, this.mcpAdapter, cachedDataSources),
      [CREATE_NODES.coder]: new CoderExecutor(this.llm, this.templateAdapter, visionOk),
      [CREATE_NODES.check]: new CheckExecutor(this.llm, checkVision, { renderShotDataUrl }),
      [CREATE_NODES.repair]: new RepairExecutor(this.llm),
      [CREATE_NODES.finish]: new FinishExecutor()
    }

    return createLoop({
      definition,
      resume,
      executors,
      onCommit: async (gs) => this.handleCommit(gs),
      onNodeComplete: (nodeId, gs, payload) => this.handleNodeComplete(nodeId, gs, payload),
      onProgress: (nodeId, detail) => this.handleProgress(nodeId, detail),
      stepTimeoutMs: Number(process.env.AGENT_STEP_MAX_MS) || 20 * 60 * 1000
    })
  }

  /** 创建 edit 流程引擎 */
  private async createEditEngine(currentHtml: string, inputText?: string, inputAttachments?: string[]): Promise<LoopEngine> {
    // edit 流程的 check 截图审查能力：同样探测模型视觉能力（不再硬编码 false）
    const cap = await getCapability()
    const checkVision = cap.ok && cap.supportsVision
    const executors: Record<string, NodeExecutor> = {
      [EDIT_NODES.editCoder]: new CoderExecutor(this.llm, this.templateAdapter, false, inputText ?? '', inputAttachments ?? [], currentHtml, this.editDataBlock),
      [EDIT_NODES.editCheck]: new CheckExecutor(this.llm, checkVision, { renderShotDataUrl }),
      [EDIT_NODES.editRepair]: new RepairExecutor(this.llm, this.editDataBlock),
      [EDIT_NODES.editFinish]: new FinishExecutor()
    }

    return createLoop({
      definition: editFlow(),
      resume: editResumeTable(),
      executors,
      onCommit: async (gs) => this.handleCommit(gs),
      onNodeComplete: (nodeId, gs, payload) => this.handleNodeComplete(nodeId, gs, payload),
      onProgress: (nodeId, detail) => this.handleProgress(nodeId, detail),
      stepTimeoutMs: Number(process.env.AGENT_STEP_MAX_MS) || 20 * 60 * 1000
    })
  }

  /* ---------- 入口：替代 orchestrator 的 handle* 函数 ---------- */

  /** 替代 handleSendMessage */
  handleMessage(text: string, attachments: string[] = []): void {
    // 推用户消息
    this.emitMessage({ kind: 'user', id: nextId('m'), createdAt: Date.now(), text, attachmentUrls: attachments, queued: false })

    // 排队（引擎正在跑）
    if (this.engine && this.engine.getState() === 'running') {
      this.queue.push({ text, attachments })
      return
    }

    // 判断 create 还是 edit
    const versions = this.loadVersions()
    // startCreate/startEdit 异步（需探测模型视觉能力），fire-and-forget 但捕获致命错误
    const startPromise = versions.length === 0
      ? this.startCreate(text, attachments)
      : this.startEdit(text, attachments, versions)
    startPromise.catch((err) => this.handleFatalError(err))
  }

  /** 启动 create 流程 */
  private async startCreate(text: string, attachments: string[]): Promise<void> {
    this.pendingText = text
    this.pendingAttachments = attachments
    // create 流程不走 edit 数据回填，清空避免上一轮 edit 的残留数据落进新版本
    this.editDataFile = null
    this.editDataBlock = ''
    const hasImage = attachments.length > 0
    const hasDs = cachedDataSources.some((s) => s.enabled && s.url)
    this.engine = await this.createCreateEngine(hasImage, text, attachments)

    // 初始化完整阶段列表（一进去就列出所有步骤，第一个 active）
    this.emitPlanStages(hasDs, hasImage)
    // 立刻推送流程图骨架（全 pending + 拓扑），不用等首个节点完成才看到图
    this.emitGraphSkeleton(selectCreateFlow(hasDs), CREATE_NODES.planner)

    this.emitRunStatus('generating')
    this.emitAgentMessage(hasImage ? '好的，我先仔细看看你发来的图片…' : '好的，我来帮你做。先理解一下你的需求…')
    this.runEngine({ kind: 'start', initialNode: CREATE_NODES.planner })
  }

  /** 启动 edit 流程 */
  private async startEdit(text: string, attachments: string[], versions: Version[]): Promise<void> {
    const current = versions.find((v) => v.isCurrent) ?? versions[0]
    const currentHtml = this.storage.readPreview(this.dashId, current.id) ?? ''
    if (!currentHtml) {
      // 没有基础版本：退化为新建
      await this.startCreate(text, attachments)
      return
    }

    this.pendingText = text
    this.currentHtml = currentHtml

    // 从源版本 data.json 回填数据上下文（修复 edit 图无 fetch 节点导致 dataBlock='' 的 bug）：
    // editDataFile 用于 commit 时写进新版本目录；editDataBlock 给 coder/repair LLM 看数据形状。
    const srcDataFile = this.storage.readDataFile<unknown[]>(this.dashId, current.id)
    if (Array.isArray(srcDataFile) && srcDataFile.length > 0) {
      this.editDataFile = srcDataFile
      this.editDataBlock = buildDataBlockFromItems(srcDataFile as DashboardDataItem[])
    } else {
      this.editDataFile = null
      this.editDataBlock = ''
    }

    this.engine = await this.createEditEngine(currentHtml, text, attachments)

    // 初始化 edit 阶段列表（修改/检查/生成预览）
    this.emitEditPlanStages()
    // 立刻推送流程图骨架（全 pending + 拓扑）
    this.emitGraphSkeleton(editFlow(), EDIT_NODES.editCoder)

    this.emitRunStatus('generating')
    this.emitAgentMessage(`收到，我来调整：「${truncate(text)}」，涉及 1 处修改。`)
    this.runEngine({ kind: 'start', initialNode: EDIT_NODES.editCoder })
  }

  /** 替代 handleAnswerClarification */
  answerClarification(messageId: string, answers: ClarificationAnswer[]): void {
    // 答案汇总写回引擎内部 planner output（用 patchNode 写引擎内部，不是拷贝）
    const summary = answers.map((a) => a.customText || a.optionId).join('；')
    this.engine?.patchNode(CREATE_NODES.planner, { output: { answersSummary: summary } })
    this.emitRunStatus('generating')
    this.emitAgentMessage('好的，就按你选的来做，马上开始。')
    this.runEngine({ kind: 'resume' })
  }

  /** 替代 handleChooseOption */
  chooseOption(optionId: string): void {
    // opt-rollback 单独处理
    if (optionId === 'opt-rollback') {
      const versions = this.loadVersions()
      const target = versions.find((v) => v.isCurrent) ?? versions[0]
      if (target) this.rollback(target.id)
      return
    }

    // opt-demo-data：清 dataBlock，继续
    if (optionId === 'opt-demo-data') {
      this.engine?.patchNode(CREATE_NODES.fetch, { refs: { dataBlock: '' } })
    }

    // opt-retry（让 AI 再试一次）：若是修复超预算挂起，重置 repair 的 attempt 计数，
    // 否则 resume 后 repair 读到旧 attempt 立刻又超预算 suspend（"马上又弹出没修好"bug）
    if (optionId === 'opt-retry') {
      const gs = this.engine?.getGraphState()
      if (gs?.awaiting === SUSPEND_TAGS.fixOverBudget) {
        const repairId = gs.nodes[CREATE_NODES.repair] ? CREATE_NODES.repair : EDIT_NODES.editRepair
        this.engine?.patchNode(repairId, { output: { attempt: 0 } })
      }
    }

    // 其余选项：恢复流程
    this.runEngine({ kind: 'resume' })
  }

  /**
   * 驱动引擎推进，捕获任何 reject（避免 fire-and-forget 静默吞错导致流程"假卡住"）。
   * 引擎主循环或执行器抛错时：打日志 + 发失败卡片 + 转 blocked 态，让用户可见可重试，
   * 而不是让 runStatus 永远停在 generating 转圈。
   */
  private runEngine(event: Parameters<LoopEngine['handleEvent']>[0]): void {
    if (!this.engine) return
    this.engine.handleEvent(event).catch((err) => {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
      console.error(`[loop-adapter] 引擎推进失败 dashId=${this.dashId} event=${event.kind}:\n${msg}`)
      this.handleFatalError(err)
    })
  }

  /** 引擎致命错误：发失败卡片 + 转 blocked（前端可见，不再静默转圈） */
  private handleFatalError(err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err)
    const msg: ProblemMessage = {
      kind: 'problem', id: nextId('m'), createdAt: Date.now(),
      title: '流程意外中断', description: `引擎内部出错：${detail}`,
      options: [{
        id: 'opt-retry', title: '重试', consequence: '重新发起本次任务',
        recommended: true, recommendReason: '重新跑一遍流程', riskLevel: 'low', autoExecuteAt: null
      }],
      chosenOptionId: null, relatedIssueId: null
    }
    this.emitMessage(msg)
    this.emitBlocker({
      id: nextId('blk'), type: 'failed', title: '流程意外中断',
      description: detail, options: msg.options, relatedMessageId: msg.id
    })
    this.emitRunStatus('blocked')
  }

  /** 替代 handleRollback */
  rollback(versionId: string): void {
    const html = this.storage.readPreview(this.dashId, versionId)
    if (!html) return
    const inheritedMeta = this.storage.readVersionMeta<DataUseEntry[]>(this.dashId, versionId)
    // 复制源版本的真实数据 data.json（大屏 HTML 运行时 fetch 读取，回退后必须仍可用）
    const inheritedData = this.storage.readDataFile<unknown[]>(this.dashId, versionId)
    const n = this.loadVersions().length + 1
    const id = nextId('ver')
    this.storage.writePreview(this.dashId, id, html)
    if (inheritedMeta && inheritedMeta.length > 0) {
      this.storage.writeVersionMeta(this.dashId, id, inheritedMeta)
    }
    if (Array.isArray(inheritedData) && inheritedData.length > 0) {
      this.storage.writeDataFile(this.dashId, id, inheritedData)
    }
    const url = `/preview/${this.dashId}/${id}/index.html`
    const v: Version = {
      id, label: `v${n}`, summary: `回退到 ${versionId}`, createdAt: Date.now(),
      screenshotUrl: '', published: false, isCurrent: true,
      dataSourcesUsed: inheritedMeta && inheritedMeta.length > 0 ? inheritedMeta : undefined
    }
    this.emitVersionAdded(v, url)
    this.emitPreviewReady(id, url)
    this.emitRunStatus('idle')
    this.emitSystemMessage(`已回退到目标版本`)
  }

  /* ---------- 引擎回调 ---------- */

  /** onCommit：流程完成时存版本 */
  private async handleCommit(gs: GraphState): Promise<void> {
    // finish 节点完成（onCommit）：推送最终流程图快照（所有节点 done）
    this.emitGraphState(gs)
    // 从所有可能持有 HTML 的节点找（coder/editCoder/repair/editRepair），取最后写入的
    let html = ''
    for (const id of [CREATE_NODES.repair, EDIT_NODES.editRepair, CREATE_NODES.coder, EDIT_NODES.editCoder]) {
      const h = gs.nodes[id]?.refs?.html
      if (h) { html = h; break }
    }
    if (!html) html = this.currentHtml

    if (!html) return

    const n = this.loadVersions().length + 1
    const id = nextId('ver')
    this.storage.writePreview(this.dashId, id, html)

    const dataSourcesUsed = gs.nodes[CREATE_NODES.fetch]?.output?.dataSourcesUsed as DataUseEntry[] | undefined
    if (dataSourcesUsed && dataSourcesUsed.length > 0) {
      this.storage.writeVersionMeta(this.dashId, id, dataSourcesUsed)
    }

    // 落盘真实数据 data.json（大屏 HTML 运行时 fetch 读取，不再写死数值）
    // create 流程从 fetch 节点 refs.dataFile（JSON 串）解析；edit 流程从暂存 this.editDataFile（数组）读
    const dataFileRaw = gs.nodes[CREATE_NODES.fetch]?.refs?.dataFile
    let dataFile: unknown[] | null = null
    if (typeof dataFileRaw === 'string' && dataFileRaw.length > 0) {
      try {
        const parsed = JSON.parse(dataFileRaw)
        if (Array.isArray(parsed) && parsed.length > 0) dataFile = parsed
      } catch {
        /* 解析失败忽略，走 editDataFile 兜底 */
      }
    }
    if (!dataFile && Array.isArray(this.editDataFile) && this.editDataFile.length > 0) {
      dataFile = this.editDataFile
    }
    if (dataFile) {
      this.storage.writeDataFile(this.dashId, id, dataFile)
    }

    const url = `/preview/${this.dashId}/${id}/index.html`
    const v: Version = {
      id, label: `v${n}`, summary: this.pendingText ? truncate(this.pendingText) : '完成',
      createdAt: Date.now(), screenshotUrl: coverFor(this.pendingText),
      published: false, isCurrent: true,
      dataSourcesUsed: dataSourcesUsed && dataSourcesUsed.length > 0 ? dataSourcesUsed : undefined
    }
    this.emitVersionAdded(v, url)
    this.emitPreviewReady(id, url)
    // 首页缩略图兜底：提交版本后设置 dashboard.coverUrl（关键词占位图）。
    // Electron 离屏截图成功后由 uploadCover 覆盖为真实预览图。
    syncAdapterDashboard(this.dashId, {
      status: 'completed',
      coverUrl: coverFor(this.pendingText)
    })
    this.emitRunStatus('idle')
    this.emitAgentMessage('你的大屏做好了！右侧预览可以看看效果，想改哪里直接跟我说。')

    // 处理排队消息
    this.drainQueue()
  }

  /** onProgress：节点执行中的实时进展（更新当前阶段的详情行，节流 600ms） */
  private progressLastPush = 0
  private handleProgress(nodeId: NodeId, detail: string): void {
    const now = Date.now()
    if (now - this.progressLastPush < 600) return // 节流 600ms
    this.progressLastPush = now
    const stageId = this.nodeToStageId(nodeId)
    if (!stageId) return
    // 找到当前阶段，更新 detail + 标记 active；首次进入时补 startedAt（否则耗时永远显示不出来）
    const stage = this.session.stages.find((s) => s.id === stageId)
    if (stage) {
      this.emitStage({
        ...stage,
        state: 'active',
        detail,
        startedAt: stage.startedAt ?? Date.now()
      })
    }
  }

  /** onNodeComplete：节点完成/挂起/失败时发 SSE 事件。suspendPayload 携带挂起相关数据（如澄清问题） */
  private handleNodeComplete(nodeId: NodeId, gs: GraphState, suspendPayload?: Record<string, unknown>): void {
    const nodeState = gs.nodes[nodeId]
    if (!nodeState) return

    // 无论 done/suspend/failed，都先把流程图快照推给前端（调试面板实时点亮节点）
    this.emitGraphState(gs)

    // 节点失败：发失败卡片 + 转 blocked（failed 时 awaiting 为空，必须单独检测，否则会被当正常完成处理）
    if (nodeState.status === 'failed') {
      const errMsg = (nodeState.output?.error as string) ?? '节点执行失败'
      this.handleFatalError(new Error(`${this.nodeToStageName(nodeId) ?? nodeId} 节点失败：${errMsg}`))
      return
    }

    // 挂起时：clarification 发澄清卡片，其他发 problem 卡片
    if (gs.awaiting) {
      if (gs.awaiting === SUSPEND_TAGS.clarification) {
        this.handleClarification(gs, suspendPayload)
      } else {
        this.handleSuspend(gs.awaiting, gs)
      }
      return
    }

    // 正常完成：映射引擎节点 -> 阶段 id（与 emitPlanStages 的 st-N 对齐）
    const stageId = this.nodeToStageId(nodeId)
    const stageName = this.nodeToStageName(nodeId)
    if (stageId && stageName) {
      // 保留该阶段最后的进展文案 + 开始时间（都在前面的 handleProgress 里写进了 session.stages），
      // 这样完成后用户还能看到"这一步最后在干啥"以及耗时
      const prev = this.session.stages.find((s) => s.id === stageId)
      this.emitStage({
        id: stageId, title: stageName, state: 'done',
        startedAt: prev?.startedAt ?? null,
        finishedAt: Date.now(),
        detail: prev?.detail ?? null
      })
    }
  }

  /** 处理澄清挂起：发 clarification 卡片（带问题选项，让用户答题） */
  private handleClarification(gs: GraphState, payload?: Record<string, unknown>): void {
    const intro = (payload?.intro as string) ?? '开始之前，想跟你确认几件事'
    const rawQuestions = Array.isArray(payload?.questions) ? payload!.questions : []
    // 规范化问题为前端契约的 ClarificationQuestion 形态
    const questions = rawQuestions.slice(0, 3).map((rq: unknown, qi: number) => {
      const q = (rq ?? {}) as Record<string, unknown>
      const rawOpts = Array.isArray(q.options) ? q.options : []
      const options = rawOpts.slice(0, 3).map((ro: unknown, oi: number) => {
        const o = (ro ?? {}) as Record<string, unknown>
        return {
          id: `q${qi + 1}-opt${oi + 1}`,
          title: String(o.title ?? '').trim(),
          consequence: String(o.consequence ?? '按这个选择继续做').trim(),
          recommended: o.recommended === true,
          recommendReason: typeof o.recommendReason === 'string' ? o.recommendReason.trim() : null,
          riskLevel: 'low' as const,
          autoExecuteAt: null
        }
      }).filter((o) => o.title.length > 0)
      return {
        id: `q${qi + 1}`,
        question: String(q.question ?? '').trim(),
        options,
        allowCustomInput: true,
        answer: null
      }
    }).filter((q) => q.question.length > 0 && q.options.length >= 2)

    if (questions.length === 0) {
      // 没有有效问题，降级为 problem 卡片
      this.handleSuspend(SUSPEND_TAGS.clarification, gs)
      return
    }

    const card = {
      kind: 'clarification' as const,
      id: nextId('m'),
      createdAt: Date.now(),
      intro,
      questions,
      answered: false
    }
    this.emitMessage(card)
    this.clarificationMessageId = card.id
    this.emitBlocker({
      id: nextId('blk'), type: 'clarification' as const,
      title: '需要你补充一点信息',
      description: '回答左边对话里的问题后，我就接着做。',
      options: [{
        id: 'opt-goto-answer', title: '去回答', consequence: '跳到对话里的问题卡片',
        recommended: true, recommendReason: '补充信息后一次通过率最高',
        riskLevel: 'low' as const, autoExecuteAt: null
      }],
      relatedMessageId: card.id
    })
    this.emitRunStatus('awaiting_clarification')
  }

  /** 处理挂起：发对应卡片 */
  private handleSuspend(reason: string, gs: GraphState): void {
    const options = this.buildSuspendOptions(reason)
    const title = this.suspendTitle(reason)
    const msg: ProblemMessage = {
      kind: 'problem', id: nextId('m'), createdAt: Date.now(),
      title, description: '', options, chosenOptionId: null, relatedIssueId: null
    }
    this.emitMessage(msg)
    this.emitBlocker({
      id: nextId('blk'), type: 'failed', title, description: '',
      options, relatedMessageId: msg.id
    })
    this.emitRunStatus('blocked')
  }

  /* ---------- 挂起辅助 ---------- */

  private suspendTitle(reason: string): string {
    switch (reason) {
      case SUSPEND_TAGS.clarification: return '需要你补充一点信息'
      case SUSPEND_TAGS.templateConfirm: return '模板库里没有完全匹配的模板'
      case SUSPEND_TAGS.datasourceDown: return '数据源连不上'
      case SUSPEND_TAGS.llmFailure: return 'AI 暂时没有回应'
      case SUSPEND_TAGS.fixOverBudget: return '自动修复没有成功'
      case SUSPEND_TAGS.overtime: return '这一步做了太久'
      default: return '需要你处理'
    }
  }

  private buildSuspendOptions(reason: string): CardOption[] {
    const now = Date.now()
    switch (reason) {
      case SUSPEND_TAGS.llmFailure:
        return [
          { id: 'opt-retry-llm', title: '让 AI 再试一次', consequence: '重新连一次 AI', recommended: true, recommendReason: '多数是网络波动', riskLevel: 'low', autoExecuteAt: now + 10_000 },
          { id: 'opt-check-settings', title: '检查模型设置', consequence: '去设置里看看', recommended: false, recommendReason: null, riskLevel: 'low', autoExecuteAt: null },
          { id: 'opt-assist', title: '呼叫人工协助', consequence: '支持人员帮你', recommended: false, recommendReason: null, riskLevel: 'medium', autoExecuteAt: null }
        ]
      case SUSPEND_TAGS.fixOverBudget:
        return [
          { id: 'opt-retry', title: '让 AI 再试一次', consequence: '再修一次', recommended: true, recommendReason: '同类问题自动修复成功率 90%+', riskLevel: 'low', autoExecuteAt: now + 10_000 },
          { id: 'opt-assist', title: '呼叫人工协助', consequence: '支持人员帮你', recommended: false, recommendReason: null, riskLevel: 'medium', autoExecuteAt: null }
        ]
      case SUSPEND_TAGS.datasourceDown:
        return [
          { id: 'opt-demo-data', title: '改用演示数据继续', consequence: '先把页面做出来', recommended: true, recommendReason: '不卡在数据源上', riskLevel: 'low', autoExecuteAt: null },
          { id: 'opt-retry-datasource', title: '再试一次取数', consequence: '重新连一次', recommended: false, recommendReason: null, riskLevel: 'low', autoExecuteAt: null },
          { id: 'opt-assist', title: '呼叫人工协助', consequence: '支持人员帮你', recommended: false, recommendReason: null, riskLevel: 'medium', autoExecuteAt: null }
        ]
      case SUSPEND_TAGS.templateConfirm:
        return [
          { id: 'opt-custom-generate', title: '自定义生成组件', consequence: '从零设计', recommended: true, recommendReason: '模板都对不上时自定义更贴合', riskLevel: 'low', autoExecuteAt: null },
          { id: 'opt-use-nearest', title: '用最接近的模板做', consequence: '用最接近的搭底子', recommended: false, recommendReason: null, riskLevel: 'low', autoExecuteAt: null }
        ]
      default:
        return [
          { id: 'opt-retry-llm', title: '让 AI 再试一次', consequence: '重新做一次', recommended: true, recommendReason: '多数能成功', riskLevel: 'low', autoExecuteAt: null },
          { id: 'opt-assist', title: '呼叫人工协助', consequence: '支持人员帮你', recommended: false, recommendReason: null, riskLevel: 'medium', autoExecuteAt: null }
        ]
    }
  }

  /* ---------- 工具方法 ---------- */

  /** 初始化 create 流程的完整阶段列表（一进去就列出所有步骤） */
  private emitPlanStages(hasFetch: boolean, hasImage: boolean): void {
    // 阶段 id 用节点名（与 onNodeComplete 的 nodeToStageId 对齐，避免两套 id 重复渲染）
    const steps: Array<{ id: string; title: string }> = []
    steps.push({ id: CREATE_NODES.planner, title: hasImage ? '分析参考图片' : '理解需求' })
    steps.push({ id: CREATE_NODES.match, title: '匹配模板' })
    if (hasFetch) steps.push({ id: CREATE_NODES.fetch, title: '获取数据' })
    steps.push({ id: CREATE_NODES.coder, title: '编写页面' })
    steps.push({ id: CREATE_NODES.check, title: '视觉检查' })
    steps.push({ id: CREATE_NODES.repair, title: '修复问题' })
    steps.push({ id: CREATE_NODES.finish, title: '生成预览' })
    this.session.stages = []
    steps.forEach((s, i) => {
      this.emitStage({
        id: s.id, title: s.title,
        state: i === 0 ? 'active' : 'pending',
        startedAt: i === 0 ? Date.now() : null,
        finishedAt: null, detail: null
      })
    })
  }

  /** 初始化 edit 流程的阶段列表 */
  private emitEditPlanStages(): void {
    this.session.stages = []
    const steps = [
      { id: EDIT_NODES.editCoder, title: '修改' },
      { id: 'st-2', title: '构建' },
      { id: EDIT_NODES.editCheck, title: '检查' }
    ]
    steps.forEach((s, i) => {
      this.emitStage({
        id: s.id, title: s.title,
        state: i === 0 ? 'active' : 'pending',
        startedAt: i === 0 ? Date.now() : null,
        finishedAt: null, detail: null
      })
    })
  }

  /** 引擎节点 -> 阶段 id（与 emitPlanStages 对齐） */
  private nodeToStageId(nodeId: string): string | null {
    // create/edit 流程的阶段 id 就是节点名本身
    const known: string[] = [...Object.values(CREATE_NODES), ...Object.values(EDIT_NODES)]
    return known.includes(nodeId) ? nodeId : null
  }

  private nodeToStageName(nodeId: string): string | null {
    const names: Record<string, string> = {
      [CREATE_NODES.planner]: '理解需求',
      [CREATE_NODES.match]: '匹配模板',
      [CREATE_NODES.fetch]: '获取数据',
      [CREATE_NODES.coder]: '编写页面',
      [CREATE_NODES.check]: '视觉检查',
      [CREATE_NODES.repair]: '修复问题',
      [CREATE_NODES.finish]: '生成预览',
      [EDIT_NODES.editCoder]: '修改',
      [EDIT_NODES.editCheck]: '检查',
      [EDIT_NODES.editRepair]: '修复问题',
      [EDIT_NODES.editFinish]: '生成预览'
    }
    return names[nodeId] ?? null
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return
    const items = this.queue.splice(0, this.queue.length)
    const text = items.map((i) => i.text).filter(Boolean).join('；')
    const attachments = items.flatMap((i) => i.attachments)
    this.handleMessage(text, attachments)
  }

  private loadVersions(): Version[] {
    return this.session.versions
  }

  /* ---------- SSE 事件发射 + session 持久化 ---------- */

  private emitMessage(m: ChatMessage): void {
    this.session.messages.push(m)
    this.storage.emit(this.dashId, 'message', { dashboardId: this.dashId, message: m })
    this.save()
  }
  private emitAgentMessage(text: string): void {
    this.emitMessage({ kind: 'agent', id: nextId('m'), createdAt: Date.now(), text })
  }
  private emitSystemMessage(text: string): void {
    this.emitMessage({ kind: 'system', id: nextId('m'), createdAt: Date.now(), text })
  }
  private emitRunStatus(status: RunStatus): void {
    this.session.runStatus = status
    // 切到非挂起态（generating/idle）时清空 blocker：表示卡点已被人或环路解除。
    // 必须同时发 blocker:null 事件——前端只监听 blocker 事件更新行动区，
    // 光发 runStatus 前端的 blocker ref 不会清空，行动区会赖着不消失。
    if (status !== 'blocked' && status !== 'awaiting_clarification' && this.session.blocker !== null) {
      this.session.blocker = null
      this.storage.emit(this.dashId, 'blocker', { dashboardId: this.dashId, blocker: null })
    }
    this.storage.emit(this.dashId, 'runStatus', { dashboardId: this.dashId, status })
    this.save()
  }
  private emitStage(stage: Stage): void {
    const i = this.session.stages.findIndex((s) => s.id === stage.id)
    if (i >= 0) this.session.stages[i] = stage
    else this.session.stages.push(stage)
    this.storage.emit(this.dashId, 'stage', { dashboardId: this.dashId, stage })
    this.save()
  }
  private emitBlocker(blocker: Blocker): void {
    this.session.blocker = blocker
    this.storage.emit(this.dashId, 'blocker', { dashboardId: this.dashId, blocker })
    this.save()
  }
  private emitVersionAdded(version: Version, url: string): void {
    this.session.versions.forEach((v) => (v.isCurrent = false))
    this.session.versions.unshift(version)
    this.session.versionUrls[version.id] = url
    this.storage.emit(this.dashId, 'versionAdded', { dashboardId: this.dashId, version })
    this.save()
  }
  private emitPreviewReady(versionId: string, url: string): void {
    this.session.preview = { state: 'ready', url }
    this.storage.emit(this.dashId, 'previewReady', { dashboardId: this.dashId, versionId, url })
    this.save()
  }

  /**
   * 推送流程图快照（调试面板用）：从引擎 GraphState 摘取可序列化字段，
   * 丢弃 definition.guards（函数不可 JSON 序列化），output/refs 用白名单提取脱敏摘要。
   * 写进 session.graph 持久化（刷新页面/重启后从 session 恢复，不丢流程图）。
   */
  private emitGraphState(gs: GraphState): void {
    // 流程已结束（finish/editFinish done 且无挂起）时，仍未执行的节点 = 被跳过（如 check 通过没走 repair）
    const finishNode = gs.nodes[CREATE_NODES.finish] ?? gs.nodes[EDIT_NODES.editFinish]
    const flowFinished = !gs.awaiting && finishNode?.status === 'done'
    const snapshot: GraphSnapshot = {
      nodes: gs.definition.nodes.map((n) => {
        const ns = gs.nodes[n.id]
        const rawStatus = ns?.status ?? 'pending'
        // 流程结束时，pending 节点标记为 skipped（"这次没走到"，区别于 done 真正完成）
        const status = flowFinished && rawStatus === 'pending' ? 'skipped' : rawStatus
        return {
          id: n.id,
          name: this.nodeToStageName(n.id) ?? n.name,
          status,
          summary: ns ? this.extractNodeSummary(n.id, ns.output, ns.refs) : {}
        }
      }),
      edges: gs.definition.edges.map((e) => ({ from: e.from, to: e.to, guard: e.guard })),
      current: gs.current,
      awaiting: gs.awaiting
    }
    this.lastGraph = snapshot
    this.session.graph = snapshot
    this.storage.emit(this.dashId, 'graph', { dashboardId: this.dashId, graph: snapshot })
    this.save() // 持久化到 session 文件（刷新/重启恢复）+ 同步到 orchestrator Runtime
  }

  /**
   * 推送流程图骨架（启动时用）：流程刚启动、第一个节点还没 done 时，
   * 先推一个全 pending 的初始图，让调试面板立刻显示完整拓扑骨架（不用等首个节点完成）。
   * current 指向 initialNode（即将执行的节点）。
   */
  private emitGraphSkeleton(definition: FlowDefinition, initialNode: NodeId): void {
    const snapshot: GraphSnapshot = {
      nodes: definition.nodes.map((n) => ({
        id: n.id,
        name: this.nodeToStageName(n.id) ?? n.name,
        status: n.id === initialNode ? 'active' : 'pending',
        summary: {}
      })),
      edges: definition.edges.map((e) => ({ from: e.from, to: e.to, guard: e.guard })),
      current: initialNode,
      awaiting: null
    }
    this.lastGraph = snapshot
    this.session.graph = snapshot
    this.storage.emit(this.dashId, 'graph', { dashboardId: this.dashId, graph: snapshot })
    this.save()
  }

  /**
   * 节点决策摘要（白名单提取，大字段转长度）：
   * 照搬 memory-block.ts 认定的核心字段——每个节点 1-3 个最能让人类看懂"做了什么决策"的值。
   * HTML/dataBlock/dataURL 等大字段绝不全文，只显示字节数。
   */
  private extractNodeSummary(
    nodeId: string,
    output: Record<string, unknown> | undefined,
    refs: Record<string, string> | undefined
  ): Record<string, string | number | boolean | null> {
    // 节点未产出（pending/active 但还没 done）时无摘要，避免误报默认值
    if (output === undefined && refs === undefined) return {}
    const o = output ?? {}
    const r = refs ?? {}
    const summary: Record<string, string | number | boolean | null> = {}

    switch (nodeId) {
      case CREATE_NODES.planner: {
        if (typeof o.analysis === 'string') summary['需求理解'] = o.analysis
        if (Array.isArray(o.attachments)) summary['参考图'] = `${o.attachments.length} 张`
        if (typeof o.answersSummary === 'string' && o.answersSummary) summary['澄清确认'] = o.answersSummary
        if (o.inventory && typeof o.inventory === 'object') {
          const inv = o.inventory as { panels?: unknown[]; kpis?: unknown[] }
          summary['精读清单'] = `${inv.panels?.length ?? 0} 面板 / ${inv.kpis?.length ?? 0} 指标`
        }
        break
      }
      case CREATE_NODES.match: {
        if (typeof o.layoutReason === 'string') summary['匹配理由'] = o.layoutReason
        if (Array.isArray(o.modules)) {
          const hit = o.modules.filter((m) => (m as { templateId?: unknown })?.templateId).length
          summary['模块命中'] = `${hit}/${o.modules.length}`
        }
        break
      }
      case CREATE_NODES.fetch: {
        if (typeof o.summary === 'string') summary['取数总结'] = o.summary
        if (Array.isArray(o.dataSourcesUsed)) {
          summary['数据来源'] = o.dataSourcesUsed
            .map((d) => `${(d as DataUseEntry).purpose.slice(0, 12)}:${(d as DataUseEntry).rows}行`)
            .join('，')
        }
        if (typeof r.dataBlock === 'string') summary['数据块'] = `${r.dataBlock.length} 字节`
        break
      }
      case CREATE_NODES.coder: {
        if (typeof r.html === 'string') summary['HTML'] = `${r.html.length} 字节`
        break
      }
      case CREATE_NODES.check: {
        const ids = Array.isArray(o.issueIds) ? (o.issueIds as Array<{ title?: string }>) : []
        summary['检查结果'] = ids.length > 0 ? `发现 ${ids.length} 个问题` : '通过'
        if (ids.length > 0) summary['问题'] = ids.map((x) => x.title ?? '').join('；').slice(0, 80)
        break
      }
      case CREATE_NODES.repair: {
        if (typeof o.attempt === 'number') summary['第几次修复'] = o.attempt
        if (typeof o.fixed === 'boolean') summary['是否修好'] = o.fixed
        if (Array.isArray(o.remainingIssues)) summary['剩余问题'] = (o.remainingIssues as string[]).length
        if (typeof r.html === 'string') summary['HTML'] = `${r.html.length} 字节`
        break
      }
      case CREATE_NODES.finish: {
        if (o.committed === true) summary['已提交'] = true
        break
      }
      // edit 流程节点复用同样模式
      case EDIT_NODES.editCoder: {
        if (typeof r.html === 'string') summary['HTML'] = `${r.html.length} 字节`
        break
      }
      case EDIT_NODES.editCheck: {
        const ids = Array.isArray(o.issueIds) ? (o.issueIds as Array<{ title?: string }>) : []
        summary['检查结果'] = ids.length > 0 ? `发现 ${ids.length} 个问题` : '通过'
        if (ids.length > 0) summary['问题'] = ids.map((x) => x.title ?? '').join('；').slice(0, 80)
        break
      }
      case EDIT_NODES.editRepair: {
        if (typeof o.attempt === 'number') summary['第几次修复'] = o.attempt
        if (typeof o.fixed === 'boolean') summary['是否修好'] = o.fixed
        if (typeof r.html === 'string') summary['HTML'] = `${r.html.length} 字节`
        break
      }
    }
    return summary
  }
}

/* ============================== 导出函数（替代 orchestrator 入口） ============================== */

export function getOrCreateAdapter(dashId: string): DashboardLoopAdapter {
  let adapter = adapters.get(dashId)
  if (!adapter) {
    adapter = new DashboardLoopAdapter(dashId)
    adapters.set(dashId, adapter)
  }
  return adapter
}

/** 初始化设置和数据源（boot 时调） */
export function initAdapterSettings(settings: ModelSettings, dataSources: McpDataSource[], tplRoot: string | null): void {
  cachedSettings = settings
  cachedDataSources = dataSources
  templatesRoot = tplRoot
}
