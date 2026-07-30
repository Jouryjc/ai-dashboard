/**
 * PlannerExecutor -- 大屏「理解需求」节点执行器。
 *
 * 对应原 orchestrator 的 callPlanner + callReplicaInventory：
 *   1. 读需求文本/附件（adapter 在 start 前把 {text, attachments, answersSummary} 写入
 *      graphState.nodes.planner.output 作为「输入区」）
 *   2. 调 LLM（planner 角色）做需求分析
 *   3. 有参考图且模型支持 vision + sharp 可用时：裁 5 块局部放大，调 vision 精读参考图
 *      （失败不阻塞，inventory=null 继续）
 *   4. needClarification 且未答过澄清 -> suspend；否则 done
 *
 * 节点只产出，不参与路由。挂起标记用 SUSPEND_TAGS.clarification（见 flow-definition）。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { LlmAdapter, ReplicaInventory } from '../executor-types'
import { SUSPEND_TAGS, CREATE_NODES } from '../flow-definition'
import { prompt } from '../../prompts'
import type { Region } from '../../replica'

/* ============================== 依赖类型 ============================== */

/**
 * 参考图复刻工具对象（可选）。由 adapter 注入 replica.ts 的能力：
 * - probeReplicaEnv / imageSize / cropImageDataUrl：裁局部放大图（sharp）
 * 没有 replica 时跳过精读，inventory=null 继续。
 */
export interface ReplicaTools {
  probeReplicaEnv(): Promise<{ ok: boolean; sharpOk: boolean; browserOk: boolean; detail: string }>
  imageSize(dataUrl: string): Promise<{ width: number; height: number }>
  cropImageDataUrl(dataUrl: string, regions: Region[]): Promise<string[]>
}

/** PlannerExecutor 构造依赖（对象注入，由 adapter 调用） */
export interface PlannerDeps {
  llm: LlmAdapter
  /** 模型是否支持看图（adapter 探测后注入） */
  visionOk: boolean
  /** 参考图复刻工具（可选，无则跳过精读） */
  replica?: ReplicaTools | null
  /** 用户需求文本（adapter 启动前传入，因为 getGraphState 返回深拷贝写不进引擎内部） */
  inputText?: string
  /** 用户附件（dataURL 或 URL） */
  inputAttachments?: string[]
}

/* ============================== 规划输出规范化 ============================== */

/** 规划结果（对应原 orchestrator 的 PlanResult 的可消费子集） */
interface PlanResult {
  analysis: string
  needClarification: boolean
  intro: string
  mapAdcode: string
  /** 原始 questions（needClarification 时透传给 adapter 发澄清卡片） */
  questions: unknown[]
}

/** 规划输出规范化：兜底空值；mapAdcode 只认 6 位数字行政区划代码 */
function normalizePlan(raw: unknown): PlanResult {
  const obj = (raw ?? {}) as Record<string, unknown>
  const analysis = typeof obj.analysis === 'string' && obj.analysis.trim() ? obj.analysis.trim() : '好的，我明白你的需求了。'
  const intro = typeof obj.intro === 'string' && obj.intro.trim() ? obj.intro.trim() : '开始之前，想跟你确认几件事'
  const questions = Array.isArray(obj.questions) ? obj.questions.slice(0, 3) : []
  const mapAdcodeRaw = typeof obj.mapAdcode === 'string' ? obj.mapAdcode.trim() : ''
  return {
    analysis,
    needClarification: obj.needClarification === true && questions.length > 0,
    intro,
    mapAdcode: /^\d{6}$/.test(mapAdcodeRaw) ? mapAdcodeRaw : '',
    questions
  }
}

/* ============================== 精读结果规范化 ============================== */

/** 精读结果规范化：字段逐个兜底；mapAdcode 只认 6 位数字行政区划代码，否则清空 */
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

/* ============================== 参考图裁剪区域 ============================== */

/**
 * 参考图局部裁剪区域：顶条 / 左栏 / 中部 / 右栏 / 底部 共 5 块。
 * 全部按比例换算并夹紧到图片范围内，任何尺寸都不会越界。
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

/* ============================== 消息内容类型 ============================== */

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type MessageContent = string | ContentPart[]

/* ============================== 执行器 ============================== */

export class PlannerExecutor implements NodeExecutor {
  private readonly llm: LlmAdapter
  private readonly visionOk: boolean
  private readonly replica: ReplicaTools | null
  private readonly inputText: string
  private readonly inputAttachments: string[]

  /** 构造注入依赖（对象形式，由 adapter 调用） */
  constructor(deps: PlannerDeps) {
    this.llm = deps.llm
    this.visionOk = deps.visionOk
    this.replica = deps.replica ?? null
    this.inputText = deps.inputText ?? ''
    this.inputAttachments = deps.inputAttachments ?? []
  }

  async execute(ctx: NodeContext): Promise<NodeResult> {
    // 1. 从构造函数读输入（adapter 启动前传入，因为 getGraphState 返回深拷贝写不进引擎内部）
    const text = this.inputText
    const attachments = this.inputAttachments
    // answersSummary 从 graphState 读（澄清恢复时 adapter 通过 restore 载入）
    const answersSummary = (ctx.graphState.nodes[CREATE_NODES.planner]?.output?.answersSummary as string) ?? ''
    const hasImage = attachments.length > 0

    // 2. 调 LLM（planner 角色）做需求分析
    let plan: PlanResult
    try {
      plan = await this.callPlanner(text, attachments, ctx)
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err : new Error(String(err)) }
    }

    ctx.report(`需求清楚了：${plan.analysis}`)

    // 3. 参考图精读（有图 + 模型能看图 + sharp 可用，且本轮还没精读时）
    //    失败不阻塞：inventory=null 继续往下走
    const existingInventory = ctx.graphState.nodes[CREATE_NODES.planner]?.output?.inventory
    let inventory: ReplicaInventory | null = null
    if (hasImage && this.visionOk && this.replica && existingInventory === undefined) {
      inventory = await this.readReferenceInventory(attachments, text, ctx)
    } else if (existingInventory !== undefined) {
      // 已有精读结果（重试/续跑）：沿用
      inventory = (existingInventory === null ? null : (existingInventory as ReplicaInventory)) ?? null
    }

    // 4. 需要澄清且还没答过 -> 挂起等用户答题（携带 questions 供 adapter 发澄清卡片）
    if (plan.needClarification && !answersSummary) {
      ctx.report('还有几个细节要跟你确认')
      return { kind: 'suspend', reason: SUSPEND_TAGS.clarification, payload: { intro: plan.intro, questions: plan.questions } }
    }

    // 5. done：产出需求理解 + 地图备料依据 + 澄清结论 + 精读清单
    return {
      kind: 'done',
      output: {
        text,          // 透传需求文本供下游 coder/check 读
        attachments,   // 透传附件供 coder 复刻参考图
        analysis: plan.analysis,
        mapAdcode: plan.mapAdcode,
        answersSummary,
        inventory
      }
    }
  }

  /** 调 planner 角色 LLM 做需求分析（vision 可用才带图） */
  private async callPlanner(text: string, attachments: string[], ctx: NodeContext): Promise<PlanResult> {
    const body = prompt('planner.user', {
      text: text || '（用户只发了图片，没有文字）',
      noVisionNote: attachments.length > 0 && !this.visionOk ? prompt('planner.user.no-vision-note') : ''
    })
    const content: MessageContent = this.visionOk
      ? [{ type: 'text', text: body }, ...attachments.map((url) => ({ type: 'image_url', image_url: { url } } as ContentPart))]
      : body
    const reply = await this.llm.chatStream(
      'planner',
      [
        { role: 'system', content: prompt('planner.system') },
        { role: 'user', content }
      ],
      (chars) => ctx.report(`正在分析需求…（${chars} 字）`),
      { signal: ctx.signal }
    )
    return normalizePlan(this.llm.extractJson(reply))
  }

  /**
   * 精读参考图（vision 角色）：原图 + 5 块局部放大裁剪图一起给模型，输出内容清单 JSON。
   * 失败返回 null（不阻塞流程）。
   */
  private async readReferenceInventory(attachments: string[], requirement: string, ctx: NodeContext): Promise<ReplicaInventory | null> {
    const refImage = attachments.find((a) => a.startsWith('data:')) ?? null
    if (!refImage || !this.replica) return null

    try {
      const env = await this.replica.probeReplicaEnv()
      if (!env.sharpOk) return null
      const size = await this.replica.imageSize(refImage)
      const regions = referenceRegions(size.width, size.height)
      ctx.report(`精读参考图：裁出 ${regions.length} 块局部放大`)
      const crops = await this.replica.cropImageDataUrl(refImage, regions)

      const content: ContentPart[] = [
        { type: 'text', text: prompt('replica.inventory.user', { requirement: requirement || '（用户只发了图片，没有文字）' }) },
        { type: 'image_url', image_url: { url: refImage } },
        ...crops.map((url) => ({ type: 'image_url', image_url: { url } } as ContentPart))
      ]
      const reply = await this.llm.chatStream(
        'vision',
        [
          { role: 'system', content: prompt('replica.inventory.system') },
          { role: 'user', content }
        ],
        (chars) => ctx.report(`正在精读参考图细节…（${chars} 字）`),
        { signal: ctx.signal }
      )
      const inventory = normalizeReplicaInventory(this.llm.extractJson(reply))
      ctx.report(`认出了 ${inventory.panels.length} 个面板、${inventory.kpis.length} 个指标`)
      return inventory
    } catch (err) {
      // 精读失败不阻塞：按现有流程继续
      ctx.report('参考图细节没读全，按看到的大概样子和描述来做')
      return null
    }
  }
}
