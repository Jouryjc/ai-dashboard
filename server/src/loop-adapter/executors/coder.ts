/**
 * CoderExecutor -- 「编写页面」节点执行器。
 *
 * 对应 orchestrator.ts 的 callCoderCreate：
 *   1. 从 ctx.graphState 读各节点 output：
 *      - planner：需求文本 / answersSummary / inventory（精读清单）/ mapAdcode
 *      - match：模板匹配结论（layoutId / modules / useTemplate）
 *      - fetch：dataBlock（从 refs.dataBlock 读；无 fetch 节点时为空串）
 *   2. 用 buildMemoryBlock(graphState) 构造流程记忆文本
 *   3. 有精读清单 -> 复刻 prompt（coder.system + coder.replica.system / coder.replica.user）
 *      否则 -> 创作 prompt（coder.system / coder.create.user）
 *   4. 调 llm.chatStream('coder', ...) 生成，extractHtml 提取
 *   5. 返回 done，html 存 refs.html
 *
 * dataBlock 从 graphState.nodes.fetch.refs.dataBlock 读取。
 * templateContext 用 findTemplate(id).html 拼模板上下文。
 * mapPaths/mapNote：地图备料先不实现（留空）。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { GraphState } from '../../../../loop-engine/src'
import type { LlmAdapter, TemplateAdapter, ReplicaInventory, MatchModule } from '../executor-types'
import { CREATE_NODES, EDIT_NODES } from '../flow-definition'
import { buildMemoryBlock } from '../memory-block'
import { extractDataSummary, truncateBytes } from '../shared-utils'
import { prompt } from '../../prompts'

/** Coder 单次生成的最大 token 数（与 orchestrator 一致，env 可调） */
const CODER_MAX_TOKENS = Number(process.env.CODER_MAX_TOKENS) || 32_000

/** 从 graphState 取节点 output（兜底空对象） */
function outputOf(gs: GraphState, nodeId: string): Record<string, unknown> {
  return (gs.nodes[nodeId]?.output ?? {}) as Record<string, unknown>
}

/** 取字符串字段（兜底空串） */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 把 match 节点的模块匹配结论还原成 MatchModule[]（容错） */
function asModules(v: unknown): MatchModule[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : '',
      slot: typeof m.slot === 'string' ? m.slot : '',
      dataKind: typeof m.dataKind === 'string' ? m.dataKind : '',
      templateId: typeof m.templateId === 'string' ? m.templateId : null,
      reason: typeof m.reason === 'string' ? m.reason : ''
    }))
    .filter((m) => m.role)
}

/**
 * 拼注入 Coder prompt 的模板上下文文本（参考 orchestrator.templateContext，简化版）。
 * 真数据摘要贴在开头，让 Coder 看模板时就能看到所有真数值。
 * 只拼文本（不附模板图片，视觉参考归 check 环节）。
 */
function buildTemplateContext(
  templateAdapter: TemplateAdapter,
  layoutId: string | null,
  modules: MatchModule[],
  dataBlock: string
): string {
  const layout = layoutId ? templateAdapter.findTemplate(layoutId) : undefined
  const moduleEntries = modules
    .map((m) => ({ m, t: m.templateId ? templateAdapter.findTemplate(m.templateId) : undefined }))
    .filter((x) => x.t)
  if (!layout && moduleEntries.length === 0) return ''

  // 真数据摘要（贴到模板注入文本开头，让 Coder 看模板时就能看到所有真数值）
  const dataSummary = extractDataSummary(dataBlock)
  const summaryNote = dataSummary
    ? `\n\n★本大屏要用的真实数值（必须用这些，禁止照抄模板里的占位数字）★：\n${dataSummary}`
    : ''

  const parts: string[] = []
  if (layout) {
    parts.push(`【布局模板：${layout.name}，照它的网格结构排版（模板里的数字是占位演示，不要照抄）】\n${layout.html}`)
  }
  for (const { m, t } of moduleEntries) {
    const slotNote = m.slot ? `，画在${m.slot}位置` : ''
    const kindNote = m.dataKind ? `，数据形态${m.dataKind}` : ''
    parts.push(
      `【模块「${m.role}」模板：${t!.name}${slotNote}${kindNote}，照样式画但数值必须用上方真实数值，禁止照抄模板数字】\n${t!.html}`
    )
  }
  return `【模板库匹配结果：照下面的模板 HTML 还原样式（CSS/结构/配色/图表形态），保证视觉还原度。但是--模板 HTML 里的所有数字都是占位演示数据，禁止照抄！页面上显示的每个数值都必须来自「真实数据」块，用真数据替换模板里的占位数字。${summaryNote}】\n${parts.join('\n\n')}`
}

export class CoderExecutor implements NodeExecutor {
  constructor(
    private readonly llm: LlmAdapter,
    private readonly templateAdapter: TemplateAdapter,
    /** 模型是否支持看图（带参考图时才附图） */
    private readonly visionOk: boolean,
    /** edit 流程的需求文本（create 流程从 graphState.planner.output 读） */
    private readonly inputText?: string,
    /** edit 流程的附件 */
    private readonly inputAttachments?: string[],
    /** edit 流程的当前 HTML（create 流程不传） */
    private readonly currentHtml?: string,
    /** edit 流程从源版本 data.json 回填的数据块文本（create 流程从 fetch 节点读） */
    private readonly editDataBlock?: string
  ) {}

  async execute(ctx: NodeContext): Promise<NodeResult> {
    // 1) 读各节点 output（create 流程从 planner 读；edit 流程从构造函数读）
    const planner = outputOf(ctx.graphState, CREATE_NODES.planner)
    const editCoder = outputOf(ctx.graphState, EDIT_NODES.editCoder)
    const text = asString(planner.text) || asString(editCoder.text) || this.inputText || ''
    const answersSummary = asString(planner.answersSummary)
    const inventory = (planner.inventory ?? null) as ReplicaInventory | null
    const attachments = Array.isArray(planner.attachments) ? (planner.attachments as string[])
      : Array.isArray(editCoder.attachments) ? (editCoder.attachments as string[])
      : this.inputAttachments ?? []

    const match = outputOf(ctx.graphState, CREATE_NODES.match)
    const layoutId = typeof match.layoutId === 'string' ? match.layoutId : null
    const modules = asModules(match.modules)
    const useTemplate = match.useTemplate !== false

    // dataBlock：create 流程从 fetch 节点 refs.dataBlock 读；edit 流程图无 fetch 节点，用回填的 editDataBlock
    const fetchNode = ctx.graphState.nodes[CREATE_NODES.fetch]
    const dataBlock = asString(fetchNode?.refs?.dataBlock) || this.editDataBlock || ''

    // 2) 流程记忆块
    const memoryBlock = buildMemoryBlock(ctx.graphState)

    // 3) 模板上下文（有匹配且 useTemplate 时）
    const templateContext =
      useTemplate ? buildTemplateContext(this.templateAdapter, layoutId, modules, dataBlock) : ''

    // 澄清答案块
    const answersBlock = answersSummary ? prompt('coder.create.answers-block', { answersSummary }) : ''

    // 4) 拼 messages：复刻分支 vs 创作分支
    let systemContent: string
    let userText: string
    let images: string[] = []

    if (this.currentHtml) {
      // edit 分支：在现有 HTML 基础上修改
      systemContent = prompt('coder.system')
      userText = prompt('coder.edit.user', {
        currentHtml: this.currentHtml,
        instruction: text || '按用户发的参考图调整',
        dataBlock
      })
    } else if (inventory) {
      // 复刻分支：有精读清单 -> 用复刻 prompt
      systemContent = `${prompt('coder.system')}\n\n${prompt('coder.replica.system')}`
      userText = prompt('coder.replica.user', {
        requirement: text || '（用户只发了图片，没有文字）',
        answers: answersBlock,
        inventory: JSON.stringify(inventory, null, 2),
        dataBlock,
        mapNote: '' // 地图备料先不实现，留空
      })
      // 模型能看图时带参考图（精读分支才有参考图）
      if (this.visionOk) {
        const refImage = attachments.find((a) => typeof a === 'string' && a.startsWith('data:'))
        if (refImage) images = [refImage]
      }
    } else {
      // 创作分支
      systemContent = prompt('coder.system')
      userText = prompt('coder.create.user', {
        text,
        answersBlock,
        templateContext,
        dataBlock,
        imageNote: '' // 模板图片参考归视觉环节，这里不带
      })
    }

    // 流程记忆块拼在 user content 里
    if (memoryBlock) userText = `${memoryBlock}\n\n${userText}`

    // 组装 user content：有图时用多模态数组，否则纯文本
    const userContent: string | unknown[] =
      images.length > 0
        ? [...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })), { type: 'text' as const, text: userText }]
        : userText

    const messages = [
      { role: 'system' as const, content: systemContent },
      { role: 'user' as const, content: userContent }
    ]

    // 5) 调 coder 生成
    ctx.report('正在编写页面…')
    let reply: string
    try {
      reply = await this.llm.chatStream(
        'coder',
        messages,
        (chars) => ctx.report(`已生成 ${chars} 字`),
        { maxTokens: CODER_MAX_TOKENS, signal: ctx.signal }
      )
    } catch (err) {
      // 被引擎看门狗中止（编码超时）：拆成「骨架 → 逐面板」的小步骤重做，
      // 对齐 orchestrator 旧路径的 splitCodingFlow——每步都是独立小调用，单步不会再超时
      if (ctx.signal.aborted) {
        ctx.report('这一步做了太久还没做完，我把它拆成几步小的来做，会快很多。')
        try {
          reply = await this.splitCoding(text, answersSummary, dataBlock, ctx)
        } catch (splitErr) {
          return { kind: 'failed', error: splitErr instanceof Error ? splitErr : new Error(String(splitErr)) }
        }
      } else {
        return { kind: 'failed', error: err instanceof Error ? err : new Error(String(err)) }
      }
    }

    // 6) extractHtml 提取
    const html = this.llm.extractHtml(reply)
    ctx.report(`写完了，共 ${html.length.toLocaleString('zh-CN')} 字`)

    // 7) 返回 done，html 存 refs.html
    return {
      kind: 'done',
      output: { summary: '生成完毕' },
      refs: { html }
    }
  }

  /**
   * 编码超时后的拆分生成（对齐 orchestrator.splitCodingFlow）：
   *   第 1 步：只生成页面骨架（完整 HTML + 全部样式 + 每面板一个 <!--PANEL:名称--> 占位注释）
   *   第 2..N 步：逐个面板生成内容片段，填回占位注释
   * 每个子步骤是独立的小 LLM 调用。注意不能传 ctx.signal——它已被看门狗中止，复用会让子步骤秒失败；
   * 单次调用仍受网关自身的角色超时约束，不会无限挂。
   */
  private async splitCoding(text: string, answersSummary: string, dataBlock: string, ctx: NodeContext): Promise<string> {
    const dataPart = dataBlock ? `\n\n${dataBlock}` : ''
    // edit 拆分必须带上当前大屏完整 HTML（丢了就会把原页面静默替换掉）
    const requirement = this.currentHtml
      ? `请在这个大屏现有 HTML 基础上修改：${text || '按用户发的参考图调整'}\n\n当前 HTML：\n${this.currentHtml}${dataPart}`
      : `请做这样一个大屏：${text}${answersSummary ? `\n用户确认的偏好：${answersSummary}` : ''}${dataPart}`

    const callStep = async (label: string, userContent: string): Promise<string> => {
      ctx.report(label)
      return this.llm.chatStream(
        'coder',
        [
          { role: 'system', content: prompt('coder.system') },
          { role: 'user', content: userContent }
        ],
        () => { /* 子步骤不汇报字数，标题已经够清楚 */ },
        { maxTokens: CODER_MAX_TOKENS }
      )
    }

    // 第 1 步：骨架
    const skeletonRaw = await callStep('拆分步骤 1：先搭页面骨架', prompt('split.skeleton.user', { requirement }))
    let html = this.llm.extractHtml(skeletonRaw)
    // 记录占位注释原文：名字 trim 后拼正则可能匹配不到含空格的原始注释，替换一律用原文
    const panels = [...html.matchAll(/<!--PANEL:([^>]+?)-->/g)]
      .map((m) => ({ raw: m[0], name: (m[1] ?? '').trim() }))
      .filter((p) => p.name.length > 0)
      .slice(0, 6)

    // 模型没按占位约定输出：骨架已是完整页面，直接用
    if (panels.length === 0) return html

    // 第 2..N 步：逐个面板生成内容；单个面板失败留占位说明，交给后续视觉检查 + 修复兜底
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]
      try {
        const fragment = await callStep(
          `拆分步骤 ${i + 2}/${panels.length + 1}：生成「${p.name.slice(0, 10)}」`,
          prompt('split.panel.user', { requirement, panelName: p.name })
        )
        html = html.replace(p.raw, () => fragment)
      } catch {
        html = html.replace(p.raw, () => `<!-- 「${p.name}」暂未生成 -->`)
      }
    }

    // 兜底：成品里不允许残留面板占位注释
    if (/<!--PANEL:/.test(html)) {
      html = html.replace(/<!--PANEL:[^>]*?-->/g, '<!-- 面板暂未生成 -->')
    }
    return html
  }
}
