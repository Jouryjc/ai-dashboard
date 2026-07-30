/**
 * RepairExecutor -- 修复问题节点执行器。
 *
 * 局部修复模式（默认）：LLM 输出 JSON 补丁信封（search-and-replace），服务端 applyHtmlEdits
 * 精确替换问题片段。秒级完成，不全量重写。
 *   - 补丁匹配失败（find 不唯一/没找到）-> 带反馈重试（不消耗视觉修复预算）
 *   - 连续 PATCH_RETRY_MAX 次补丁格式失败 -> 降级全量重写（兜底）
 * 全量重写模式（兜底）：LLM 输出完整 HTML，extractHtml 提取。慢但稳。
 *
 * 预算闸（REPAIR_BUDGET）：视觉问题修复次数上限，补丁格式失败不计数。
 * repair done 后引擎回 check 复检；check.issueIds 仍非空又回 repair，attempt 累加。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { LlmAdapter } from '../executor-types'
import { validateHtml, applyHtmlEdits, type HtmlEdit } from '../shared-utils'
import { buildMemoryBlock } from '../memory-block'
import { prompt } from '../../prompts'
import { CREATE_NODES, EDIT_NODES, SUSPEND_TAGS } from '../flow-definition'

/** Coder 单次生成的最大 token 数（与 orchestrator 一致） */
const CODER_MAX_TOKENS = Number(process.env.CODER_MAX_TOKENS) || 32_000

/** 自动修复预算上限（视觉问题修复次数，达到即 suspend 等用户选择） */
const REPAIR_BUDGET = 2
/** 补丁格式失败重试上限（find 匹配不上等格式问题，不消耗视觉修复预算） */
const PATCH_RETRY_MAX = 2

/** check 节点产出的问题项（title + detail，detail 含位置+修法建议） */
interface IssueItem {
  title: string
  detail: string
}

export class RepairExecutor implements NodeExecutor {
  constructor(
    private readonly llm: LlmAdapter,
    /** edit 流程从源版本 data.json 回填的数据块文本（create 流程从 fetch 节点读） */
    private readonly editDataBlock?: string
  ) {}

  async execute(ctx: NodeContext): Promise<NodeResult> {
    const gs = ctx.graphState

    // 1. 读上游产出：check 的问题清单（{title, detail}[]）
    const checkNode = gs.nodes[CREATE_NODES.check] ?? gs.nodes[EDIT_NODES.editCheck]
    const issues = Array.isArray(checkNode?.output?.issueIds)
      ? (checkNode!.output!.issueIds as IssueItem[])
      : []

    // 没有问题就不该进 repair（guard isPassed 已拦），防御性直接通过
    if (issues.length === 0) {
      return { kind: 'done', output: { attempt: 0, fixed: true } }
    }

    // 当前 HTML：优先 repair/editRepair（上一轮修复后的），其次 coder/editCoder（首次生成的）
    const html =
      gs.nodes[CREATE_NODES.repair]?.refs?.html ??
      gs.nodes[EDIT_NODES.editRepair]?.refs?.html ??
      gs.nodes[CREATE_NODES.coder]?.refs?.html ??
      gs.nodes[EDIT_NODES.editCoder]?.refs?.html ??
      ''

    // 已尝试次数：repair 自身 output.attempt，首次为 undefined=0
    const previousAttemptRaw = gs.nodes[CREATE_NODES.repair]?.output?.attempt
    const previousAttempt =
      typeof previousAttemptRaw === 'number' && Number.isFinite(previousAttemptRaw)
        ? previousAttemptRaw
        : 0
    const currentAttempt = previousAttempt + 1

    // dataBlock：create 流程从 fetch 节点 refs 读；edit 流程图无 fetch 节点，用回填的 editDataBlock
    const dataBlock =
      (gs.nodes[CREATE_NODES.fetch]?.refs?.dataBlock as string | undefined) ?? this.editDataBlock ?? ''

    // 流程记忆回灌（数据用途映射 + 模板匹配理由 + 需求理解，修复时也要遵守）
    const memoryBlock = buildMemoryBlock(gs)

    // 2. 预算闸（前置）：达到修复次数上限直接挂起，等用户决定。
    //    ★必须前置★：repair 自己只做结构校验（validateHtml），无法判断视觉问题是否真修好
    //    （那是 check 的 LLM 审查职责）。补丁格式失败不消耗预算，只有真正改了 HTML 才算一次。
    if (currentAttempt > REPAIR_BUDGET) {
      ctx.report('自动修复没有成功，等你决定')
      return { kind: 'suspend', reason: SUSPEND_TAGS.fixOverBudget }
    }

    // 3. 局部修复：先尝试补丁模式（快），失败降级全量重写（兜底）
    ctx.report(`正在修复问题（第 ${currentAttempt} 次）`)
    const repairedHtml = await this.repairWithFallback(html, issues, dataBlock, memoryBlock, ctx)

    // 4. 结构硬校验（只能查 html/body 完整性等，查不了视觉问题）
    const remainingProblems = validateHtml(repairedHtml)

    // 5. 结构都没过（HTML 残缺）-> 视为没修好（fixed:false），回 check 复检
    if (remainingProblems.length > 0) {
      ctx.report(`还剩 ${remainingProblems.length} 个结构问题没修好`)
      return {
        kind: 'done',
        output: { attempt: currentAttempt, fixed: false, remainingIssues: remainingProblems },
        refs: { html: repairedHtml }
      }
    }

    // 6. 结构通过：repair 不自判 fixed（视觉问题要由 check 复检），
    //    返回 done 让引擎回 check 做真正的 LLM 审查。attempt 已达上限时下一次进 repair 会被预算闸拦下。
    ctx.report('修复完成，回去复查')
    return {
      kind: 'done',
      output: { attempt: currentAttempt, fixed: null },
      refs: { html: repairedHtml }
    }
  }

  /**
   * 先尝试补丁模式（局部修复），连续 PATCH_RETRY_MAX 次补丁格式失败则降级全量重写。
   * 返回修复后的 HTML（补丁成功=局部改的；降级=全量重写的）。
   */
  private async repairWithFallback(
    html: string,
    issues: IssueItem[],
    dataBlock: string,
    memoryBlock: string,
    ctx: NodeContext
  ): Promise<string> {
    let lastFeedback = ''
    for (let retry = 0; retry < PATCH_RETRY_MAX; retry++) {
      ctx.report(retry === 0 ? '正在生成补丁修复' : '补丁匹配失败，按反馈重新生成补丁')
      const result = await this.callCoderPatch(html, issues, dataBlock, memoryBlock, lastFeedback, ctx)
      if (result.allOk) {
        ctx.report(`补丁应用成功（${result.results.length} 处修改）`)
        return result.html
      }
      // 补丁格式失败：拼反馈进下一轮
      lastFeedback = this.formatPatchFeedback(result.results)
      ctx.report(`补丁匹配失败（第 ${retry + 1} 次），将重试`)
    }
    // 补丁连续失败：降级全量重写
    ctx.report('补丁多次匹配失败，改用全量重写')
    return this.callCoderFullRewrite(html, issues, dataBlock, memoryBlock, ctx)
  }

  /**
   * 补丁模式：LLM 输出 JSON 补丁信封 {edits:[{reason,find,replace}]}，applyHtmlEdits 应用。
   * 成功返回 {html, allOk:true}；失败返回 {html:原html, allOk:false, results}（含失败原因+相似片段）。
   */
  private async callCoderPatch(
    html: string,
    issues: IssueItem[],
    dataBlock: string,
    memoryBlock: string,
    feedback: string,
    ctx: NodeContext
  ): Promise<{ html: string; results: ReturnType<typeof applyHtmlEdits>['results']; allOk: boolean }> {
    const dataPart = memoryBlock ? `${memoryBlock}\n\n${dataBlock}` : dataBlock
    const reply = await this.llm.chatStream(
      'coder',
      [
        { role: 'system', content: prompt('coder.system') },
        {
          role: 'user',
          content: prompt('coder.repair.user', {
            problems: this.formatIssues(issues),
            html,
            dataBlock: dataPart,
            feedback: feedback ? `\n\n上一轮补丁应用失败，原因和原文相似片段如下（据此修正 find 片段后重试）：\n${feedback}` : ''
          })
        }
      ],
      (_chars, _partial) => ctx.report('正在生成补丁'),
      { maxTokens: CODER_MAX_TOKENS, signal: ctx.signal }
    )
    let edits: HtmlEdit[]
    try {
      const parsed = this.llm.extractJson(reply) as { edits?: unknown }
      if (!Array.isArray(parsed.edits)) {
        // LLM 没输出补丁格式（可能输出了完整 HTML）-> 视为补丁失败
        return { html, results: [], allOk: false }
      }
      edits = parsed.edits.filter(
        (e): e is HtmlEdit =>
          !!e && typeof e === 'object' && typeof (e as HtmlEdit).find === 'string' && typeof (e as HtmlEdit).replace === 'string'
      )
    } catch {
      // JSON 解析失败 -> 补丁失败
      return { html, results: [], allOk: false }
    }
    if (edits.length === 0) return { html, results: [], allOk: false }
    const result = applyHtmlEdits(html, edits)
    return { html: result.html, results: result.results, allOk: result.allOk }
  }

  /** 全量重写兜底（旧逻辑）：LLM 输出完整 HTML，extractHtml 提取 */
  private async callCoderFullRewrite(
    html: string,
    issues: IssueItem[],
    dataBlock: string,
    memoryBlock: string,
    ctx: NodeContext
  ): Promise<string> {
    const dataPart = memoryBlock ? `${memoryBlock}\n\n${dataBlock}` : dataBlock
    const reply = await this.llm.chatStream(
      'coder',
      [
        { role: 'system', content: prompt('coder.system') },
        {
          role: 'user',
          content: prompt('coder.repair.fullrewrite', {
            problems: this.formatIssues(issues),
            html,
            dataBlock: dataPart
          })
        }
      ],
      (_chars, _partial) => ctx.report('正在全量重写修复'),
      { maxTokens: CODER_MAX_TOKENS, signal: ctx.signal }
    )
    return this.llm.extractHtml(reply)
  }

  /** 把问题清单格式化成 prompt 文本（含 title + detail 位置/修法） */
  private formatIssues(issues: IssueItem[]): string {
    return issues.map((i) => `- ${i.title}${i.detail ? `（${i.detail}）` : ''}`).join('\n')
  }

  /** 把补丁应用结果格式化成反馈文本（给 LLM 下一轮修正 find 用） */
  private formatPatchFeedback(results: ReturnType<typeof applyHtmlEdits>['results']): string {
    return results
      .map((r, i) => {
        if (r.ok) return `${i + 1}. ✅ 已替换：${r.find}`
        return `${i + 1}. ❌ 失败：${r.find}\n   原因：${r.reason}\n   原文最相似片段：${r.context || '（无）'}`
      })
      .join('\n')
  }
}
