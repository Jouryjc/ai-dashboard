/**
 * MatchExecutor -- 大屏「匹配模板」节点执行器。
 *
 * 对应原 orchestrator 的 callTemplateMatch：
 *   1. 读 planner 节点 output（需求文本、附件）
 *   2. 调 LLM（planner 角色）做模块化模板匹配（每个模块带角色/槽位/数据形态/模板id）
 *   3. 模型支持 vision 时把模板缩略图作为 image_url 附上（缩略图视觉比对）
 *   4. 有命中（layoutId!=null 或有 module.templateId）-> done，把原来被丢弃的匹配理由
 *      救回存进 layoutReason；完全没命中 -> suspend（等用户确认自定义还是用最接近模板）
 *
 * 挂起标记用 SUSPEND_TAGS.templateConfirm（见 flow-definition）。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { LlmAdapter, TemplateAdapter, MatchModule } from '../executor-types'
import { SUSPEND_TAGS, CREATE_NODES } from '../flow-definition'
import { prompt } from '../../prompts'

/* ============================== 依赖类型 ============================== */

/** MatchExecutor 构造依赖（对象注入，由 adapter 调用） */
export interface MatchDeps {
  llm: LlmAdapter
  /** 模板目录能力（catalogText/keywordHint/findTemplate/templatesByType/templateImageDataUrl） */
  templates: TemplateAdapter
  /** 模板文件根目录（templateImageDataUrl 用它定位 PNG） */
  templatesRoot: string
  /** 模型是否支持看图（vision 可用才附模板缩略图） */
  visionOk: boolean
}

/* ============================== 匹配结果规范化 ============================== */

/** 原始解析形态（match.system prompt 的 JSON 契约） */
interface RawMatch {
  layoutId?: unknown
  modules?: unknown
  unmatched?: unknown
}

/**
 * 模块化匹配结果规范化：
 * - layoutId 必须在布局模板目录里（否则 null）
 * - modules.templateId 必须在组件模板目录里（null 保留=自定义）
 * - 没角色的模块丢弃
 */
function normalizeMatch(
  raw: unknown,
  layoutIds: Set<string>,
  componentIds: Set<string>
): { layoutId: string | null; modules: MatchModule[]; unmatched: string[] } {
  const o = (raw ?? {}) as RawMatch
  const layoutId =
    typeof o.layoutId === 'string' && layoutIds.has(o.layoutId) ? o.layoutId : null
  const rawModules: unknown[] = Array.isArray(o.modules) ? o.modules : []
  const modules: MatchModule[] = rawModules
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    .map((m): MatchModule => ({
      role: typeof m.role === 'string' ? m.role : '',
      slot: typeof m.slot === 'string' ? m.slot : '',
      dataKind: typeof m.dataKind === 'string' ? m.dataKind : '',
      templateId:
        typeof m.templateId === 'string' && componentIds.has(m.templateId) ? m.templateId : null,
      reason: typeof m.reason === 'string' ? m.reason : ''
    }))
    .filter((m) => m.role) // 没角色的模块丢弃
  const unmatched = Array.isArray(o.unmatched) ? o.unmatched.map(String).filter(Boolean) : []
  return { layoutId, modules, unmatched }
}

/* ============================== 消息内容类型 ============================== */

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type MessageContent = string | ContentPart[]

/* ============================== 执行器 ============================== */

export class MatchExecutor implements NodeExecutor {
  private readonly llm: LlmAdapter
  private readonly templates: TemplateAdapter
  private readonly templatesRoot: string
  private readonly visionOk: boolean

  /** 构造注入依赖（对象形式，由 adapter 调用） */
  constructor(deps: MatchDeps) {
    this.llm = deps.llm
    this.templates = deps.templates
    this.templatesRoot = deps.templatesRoot
    this.visionOk = deps.visionOk
  }

  async execute(ctx: NodeContext): Promise<NodeResult> {
    // 1. 读 planner 节点 output（需求文本、附件）
    const planner = (ctx.graphState.nodes[CREATE_NODES.planner]?.output ?? {}) as Record<string, unknown>
    const text = typeof planner.text === 'string' ? planner.text : ''
    const attachments = Array.isArray(planner.attachments)
      ? planner.attachments.filter((a): a is string => typeof a === 'string')
      : []

    // 2. 调 LLM（planner 角色）做模板匹配
    let layoutId: string | null
    let modules: MatchModule[]
    let unmatched: string[]
    try {
      ;({ layoutId, modules, unmatched } = await this.callTemplateMatch(text, attachments, ctx))
    } catch (err) {
      // 匹配失败不阻塞：按全自定义继续（等价于没命中，交给用户确认）
      return { kind: 'suspend', reason: SUSPEND_TAGS.templateConfirm }
    }

    const hasHit = layoutId !== null || modules.some((m) => m.templateId)
    if (!hasHit) {
      // 完全没命中：让用户确认自定义还是用最接近模板
      ctx.report('没有命中，按你的需求自定义做')
      return { kind: 'suspend', reason: SUSPEND_TAGS.templateConfirm }
    }

    // 3. 有命中（含部分命中）：继续，未覆盖部分自定义
    //    ★救回 layoutReason★：原来被丢弃的匹配理由，现在存进 output（供 Coder 记忆块引用）
    const layoutReason = this.buildLayoutReason(layoutId, modules, unmatched)
    ctx.report(`模板匹配好了：${layoutReason}`)
    return {
      kind: 'done',
      output: {
        layoutId,
        layoutReason,
        modules,
        useTemplate: true
      }
    }
  }

  /** 调 planner 角色 LLM 做模块化模板匹配 */
  private async callTemplateMatch(
    text: string,
    attachments: string[],
    ctx: NodeContext
  ): Promise<{ layoutId: string | null; modules: MatchModule[]; unmatched: string[] }> {
    const modeNote = this.visionOk ? prompt('match.note-vision') : prompt('match.note-text')
    const content: ContentPart[] = [
      {
        type: 'text',
        text: prompt('match.user', {
          text,
          catalog: this.templates.catalogText(),
          keywordHint: this.templates.keywordHint(text),
          modeNote
        })
      }
    ]

    // vision 可用：只附用户参考图（首张）做视觉参考，不带模板缩略图（多图请求太慢）
    if (this.visionOk) {
      for (const url of attachments.slice(0, 1)) {
        content.push({ type: 'image_url', image_url: { url } })
      }
    }

    const reply = await this.llm.chatStream(
      'planner',
      [
        { role: 'system', content: prompt('match.system') },
        { role: 'user', content }
      ],
      (chars) => ctx.report(`正在比对模板…（${chars} 字）`),
      { signal: ctx.signal }
    )

    // 校验：layoutId 必须是布局模板；module.templateId 必须是组件模板（null 保留=自定义）
    const layoutIds = new Set(this.templates.templatesByType('layout').map((t) => t.id))
    const componentIds = new Set(this.templates.templatesByType('component').map((t) => t.id))
    return normalizeMatch(this.llm.extractJson(reply), layoutIds, componentIds)
  }

  /**
   * 拼匹配理由（救回原 orchestrator 被丢弃的 layoutReason）。
   * 布局命中带名字；模块命中带角色；未覆盖部分说明自定义。
   */
  private buildLayoutReason(layoutId: string | null, modules: MatchModule[], unmatched: string[]): string {
    const parts: string[] = []
    if (layoutId) {
      const name = this.templates.findTemplate(layoutId)?.name
      parts.push(name ? `布局用「${name}」` : '布局已匹配')
    }
    const moduleRoles = modules.filter((m) => m.templateId).map((m) => `「${m.role}」`)
    if (moduleRoles.length > 0) parts.push(`模块匹配到 ${moduleRoles.join('、')}`)
    if (unmatched.length > 0) parts.push(`「${unmatched.join('、')}」模板库没有，按需求自定义`)
    return parts.join('，') || '已匹配模板'
  }
}
