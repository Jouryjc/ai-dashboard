/**
 * CheckExecutor -- 视觉检查节点执行器。
 *
 * 对应原 orchestrator 的 validateHtml + callShotReview/callVisualReview（checkRepairAndFinish 前半段）。
 *   1. 从 coder 节点 refs.html 读 HTML 产物
 *   2. validateHtml 确定性硬校验
 *   3. visionOk 且截图浏览器可用：renderShotDataUrl 截图 -> callShotReview（vision 角色）
 *      否则文本审查兜底：callVisualReview（planner 角色）
 *   4. 硬校验 + 审查问题合并去重，取前 3 个
 *   5. 返回 {kind:'done', output:{issueIds: problems}}
 *      issueIds 为空数组 = 通过（引擎 guard isPassed 走 check->finish）；非空 = 有问题（走 check->repair）
 *
 * 审查失败不阻塞：review=[] 时用硬校验兜底。issueIds 是问题标题字符串数组。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { LlmAdapter } from '../executor-types'
import { validateHtml } from '../shared-utils'
import { prompt } from '../../prompts'
import { CREATE_NODES, EDIT_NODES } from '../flow-definition'

/** 截图依赖（replica.renderShotDataUrl），构造时注入 */
export interface ReplicaShotDep {
  renderShotDataUrl: (html: string, width: number, height: number) => Promise<string>
}

/** 审查问题（与 orchestrator.ReviewIssue 同形态） */
interface ReviewIssue {
  title: string
  detail: string
}

/** 大屏检查/修改检查节点共用此执行器（edit 流程的 editCheck 也用本类） */
export class CheckExecutor implements NodeExecutor {
  constructor(
    private readonly llm: LlmAdapter,
    private readonly visionOk: boolean,
    private readonly replica?: ReplicaShotDep
  ) {}

  async execute(ctx: NodeContext): Promise<NodeResult> {
    const gs = ctx.graphState

    // 1. 读最新 HTML 产物：优先 repair/editRepair（修复后的），其次 coder/editCoder（首次生成的）
    const html =
      gs.nodes[CREATE_NODES.repair]?.refs?.html ??
      gs.nodes[EDIT_NODES.editRepair]?.refs?.html ??
      gs.nodes[CREATE_NODES.coder]?.refs?.html ??
      gs.nodes[EDIT_NODES.editCoder]?.refs?.html ??
      ''

    if (!html) {
      // 没有产物可查，视为有问题（不应发生，防御性返回）
      return { kind: 'done', output: { issueIds: [{ title: '页面还没有生成', detail: '' }] } }
    }

    // 读用户需求（requirement）与参考图：create 从 planner.output，edit 从 editCoder.output
    const plannerOut = (gs.nodes[CREATE_NODES.planner]?.output ?? {}) as Record<string, unknown>
    const editCoderOut = (gs.nodes[EDIT_NODES.editCoder]?.output ?? {}) as Record<string, unknown>
    const requirementRaw = (plannerOut.text ?? editCoderOut.text ?? '') as string
    const requirement = String(requirementRaw || '（用户只发了图片，没有文字）')
    const attachments = Array.isArray(plannerOut.attachments)
      ? (plannerOut.attachments as string[])
      : Array.isArray(editCoderOut.attachments)
        ? (editCoderOut.attachments as string[])
        : []
    // 参考图：仅模型能看图时带上（与 orchestrator 一致）
    const referenceImage = this.visionOk
      ? (attachments.find((a) => typeof a === 'string' && a.startsWith('data:')) ?? null)
      : null

    // 2. 确定性硬校验
    const hard = validateHtml(html)

    // 3. 审查：截图验收路径优先，失败回落文本审查；审查任何一环失败不阻塞（review=[] 兜底）
    let review: ReviewIssue[] = []
    let usedShotReview = false

    if (this.visionOk && this.replica) {
      try {
        ctx.report('正在给页面截图，照着要求对比检查…')
        const shotDataUrl = await this.replica.renderShotDataUrl(html, 1920, 1080)
        ctx.report(referenceImage ? '拿着截图和参考图对比检查' : '拿着截图逐项检查')
        review = await this.callShotReview(shotDataUrl, referenceImage, requirement, ctx)
        usedShotReview = true
      } catch {
        // 截图或审查失败 -> 回落文本审查（与 orchestrator 一致）
        review = []
        usedShotReview = false
      }
    }

    if (!usedShotReview) {
      // 文本审查兜底（无截图浏览器 / 模型看不了图 / 截图路径失败）
      try {
        ctx.report('检查页面源码布局')
        review = await this.callVisualReview(html, requirement, ctx)
      } catch {
        // 审查没完成，用硬性检查结果兜底
        review = []
      }
    }

    // 4. 硬校验 + 审查问题合并去重（保留 detail：位置+修法建议，供 repair 局部修复定位）
    const seenTitles = new Set<string>()
    const problems: ReviewIssue[] = []
    for (const h of hard) {
      if (!seenTitles.has(h)) { seenTitles.add(h); problems.push({ title: h, detail: '' }) }
    }
    for (const r of review) {
      if (!seenTitles.has(r.title)) { seenTitles.add(r.title); problems.push({ title: r.title, detail: r.detail }) }
    }

    // 5. 取前 3 个（与 orchestrator 一致：每个问题一张 Issue 卡，最多 3 张）
    const issueIds = problems.slice(0, 3)

    ctx.report(issueIds.length > 0 ? `发现 ${issueIds.length} 个问题` : '检查通过')
    return { kind: 'done', output: { issueIds } }
  }

  /** 文本审查（planner 角色）：成品 HTML 源码 -> 问题清单 JSON */
  private async callVisualReview(html: string, requirement: string, ctx: NodeContext): Promise<ReviewIssue[]> {
    const reply = await this.llm.chatStream(
      'planner',
      [
        { role: 'system', content: prompt('review.system') },
        { role: 'user', content: prompt('review.user', { requirement, html }) }
      ],
      (_chars, _partial) => ctx.report('正在审查布局'),
      { signal: ctx.signal }
    )
    const parsed = this.llm.extractJson(reply) as { issues?: Array<{ title?: unknown; detail?: unknown }> }
    if (!Array.isArray(parsed.issues)) return []
    return parsed.issues
      .slice(0, 3)
      .map((i) => ({ title: String(i.title ?? '').trim(), detail: String(i.detail ?? '').trim() }))
      .filter((i) => i.title.length > 0)
  }

  /** 截图验收（vision 角色）：成品截图 + 参考图（有就带）-> 问题清单 JSON */
  private async callShotReview(
    screenshot: string,
    referenceImage: string | null,
    requirement: string,
    ctx: NodeContext
  ): Promise<ReviewIssue[]> {
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: prompt('review.shot.user', { requirement }) },
      { type: 'image_url', image_url: { url: screenshot } }
    ]
    if (referenceImage) content.push({ type: 'image_url', image_url: { url: referenceImage } })

    const reply = await this.llm.chatStream(
      'vision',
      [
        { role: 'system', content: prompt('review.shot.system') },
        { role: 'user', content }
      ],
      (_chars, _partial) => ctx.report('正在对比检查'),
      { signal: ctx.signal }
    )
    const parsed = this.llm.extractJson(reply) as { issues?: Array<{ title?: unknown; detail?: unknown }> }
    if (!Array.isArray(parsed.issues)) return []
    return parsed.issues
      .slice(0, 3)
      .map((i) => ({ title: String(i.title ?? '').trim(), detail: String(i.detail ?? '').trim() }))
      .filter((i) => i.title.length > 0)
  }
}
