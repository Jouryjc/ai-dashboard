/**
 * FetchExecutor -- 「获取数据」节点执行器。
 *
 * 对应 orchestrator.ts 的 fetchDataForCreate 全流程：
 *   1. 组装工具目录（listTools，连不上的记 listErrors）
 *   2. 预取指标/模型清单（list_metrics/list_models），拼进工具目录
 *   3. 全部源连不上 -> suspend(datasource_down)
 *   4. 取数规划 LLM（planner 角色）-> normalizeDataFetchCalls 白名单过滤
 *   5. calls 为空 -> 演示数据，done（dataBlock 为空串）
 *   6. 逐个 callTool（最多 2 轮纠错），首轮失败把执行结果反馈给规划 LLM 纠正参数
 *   7. 全部失败 -> suspend(datasource_down)
 *   8. 成功 -> buildDataBlock 拼数据块，done（dataBlock 存 output.refs.dataBlock）
 *
 * dataBlock 全文存在 output.refs.dataBlock（大屏流程简单，先内联在 graphState 里）。
 * 取数明细 dataSourcesUsed 存 output，供版本抽屉展示。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'
import type { GraphState } from '../../../../loop-engine/src'
import type { LlmAdapter, McpAdapter, DataFetchCall } from '../executor-types'
import type { McpDataSource, DataUseEntry } from '../../wire'
import { CREATE_NODES, SUSPEND_TAGS } from '../flow-definition'
import {
  buildDataBlock,
  buildDataItems,
  normalizeToolResult,
  parseListItems,
  truncateBytes,
  toDataUseEntry,
  toFailedEntry
} from '../shared-utils'
import { prompt } from '../../prompts'

/** 取数规划白名单过滤后保留的 call 上限（与 orchestrator 一致） */
const MAX_CALLS = 6
/** 取数纠错轮上限（首轮 + 1 轮纠错） */
const MAX_ROUNDS = 2

/** 从 graphState 取节点 output（兜底空对象） */
function outputOf(gs: GraphState, nodeId: string): Record<string, unknown> {
  return (gs.nodes[nodeId]?.output ?? {}) as Record<string, unknown>
}

/** 取字符串字段（兜底空串） */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 取数规划确定性规范化：白名单过滤（sourceId/tool 必须在已配置且启用的清单内，非法丢弃）。
 * calls 上限 MAX_CALLS。
 */
function normalizeDataFetchCalls(raw: unknown, whitelist: Map<string, Set<string>>): DataFetchCall[] {
  const obj = (raw ?? {}) as Record<string, unknown>
  const arr = Array.isArray(obj.calls) ? obj.calls : []
  const out: DataFetchCall[] = []
  for (const item of arr) {
    if (out.length >= MAX_CALLS) break
    const c = (item ?? {}) as Record<string, unknown>
    if (typeof c.sourceId !== 'string' || typeof c.tool !== 'string') continue
    const tools = whitelist.get(c.sourceId)
    if (!tools || !tools.has(c.tool)) continue
    out.push({
      sourceId: c.sourceId,
      tool: c.tool,
      args:
        c.args && typeof c.args === 'object' && !Array.isArray(c.args)
          ? (c.args as Record<string, unknown>)
          : {},
      purpose: typeof c.purpose === 'string' ? c.purpose.trim() : ''
    })
  }
  return out
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
 * 取数规划 LLM 调用：planner 角色 + extractJson，规范化交给调用方。
 * 纠错轮把 previousAttempts 拼进 user prompt。
 */
async function callDataFetchPlan(
  llm: LlmAdapter,
  text: string,
  answersSummary: string,
  toolsCatalog: string,
  onProgress: (chars: number, partial: string) => void,
  signal: AbortSignal,
  previousAttempts?: string
): Promise<unknown> {
  const reply = await llm.chatStream(
    'planner',
    [
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
    onProgress,
    { signal }
  )
  return llm.extractJson(reply)
}

export class FetchExecutor implements NodeExecutor {
  constructor(
    private readonly llm: LlmAdapter,
    private readonly mcp: McpAdapter,
    /** 已配置的数据源列表（执行器自己按 enabled+url 过滤） */
    private readonly dataSources: McpDataSource[]
  ) {}

  async execute(ctx: NodeContext): Promise<NodeResult> {
    // 0) 如果已决定用演示数据（opt-demo-data 设了 refs.dataBlock=''），直接返回演示数据
    const existingDataBlock = ctx.graphState.nodes[CREATE_NODES.fetch]?.refs?.dataBlock
    if (existingDataBlock !== undefined) {
      ctx.report(existingDataBlock ? '沿用上次取数结果' : '用演示数据')
      return {
        kind: 'done',
        output: { usage: [], dataSourcesUsed: [], summary: existingDataBlock ? '沿用上次取数' : '用演示数据' },
        refs: { dataBlock: existingDataBlock }
      }
    }

    const sources = this.dataSources.filter((s) => s.enabled && s.url)

    // 从 planner 节点读需求文本与澄清答案
    const planner = outputOf(ctx.graphState, CREATE_NODES.planner)
    const text = asString(planner.text)
    const answersSummary = asString(planner.answersSummary)

    // 1) 组装工具目录（工具名 + 参数 schema + 大白话用途）；连不上的源记下来，不进白名单
    ctx.report('正在浏览数据源有哪些工具…')
    const catalogLines: string[] = []
    const whitelist = new Map<string, Set<string>>()
    const sourceById = new Map<string, McpDataSource>()
    const listErrors: string[] = []
    for (const s of sources) {
      sourceById.set(s.id, s)
      try {
        const tools = await this.mcp.listTools(s)
        whitelist.set(s.id, new Set(tools.map((t) => t.name)))
        catalogLines.push(`数据源「${s.name || s.url}」（sourceId：${s.id}），可用工具：`)
        for (const t of tools) {
          const schemaText = t.inputSchema ? truncateBytes(JSON.stringify(t.inputSchema), 300) : ''
          catalogLines.push(
            `- ${t.name}${t.description ? `：${t.description}` : ''}${schemaText ? `（参数：${schemaText}）` : ''}`
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : `「${s.name || s.url}」连不上`
        listErrors.push(`「${s.name || s.url}」${msg}`)
      }
    }

    // 1.5) 主动预取指标与模型清单，拼进工具目录，让 LLM 直接看到具体 id 去 query 取数
    ctx.report('正在浏览数据源有哪些指标和数据表…')
    for (const s of sources) {
      const tools = whitelist.get(s.id)
      if (!tools) continue
      const previewLines: string[] = []
      if (tools.has('list_metrics')) {
        try {
          const out = await this.mcp.callTool(s, 'list_metrics', {})
          const items = parseListItems(out)
          if (items.length > 0) {
            previewLines.push(`该数据源已注册的指标（直接用 id 调 query_metric 取数，不必再调 list_metrics）：`)
            for (const it of items.slice(0, 20)) {
              previewLines.push(`  - 指标 id="${it.id}"${it.name ? `（${it.name}）` : ''}${it.description ? `：${it.description}` : ''}`)
            }
            if (items.length > 20) previewLines.push(`  …共 ${items.length} 个，已列前 20 个`)
          }
        } catch {
          /* 预取失败不阻塞 */
        }
      }
      if (tools.has('list_models')) {
        try {
          const out = await this.mcp.callTool(s, 'list_models', {})
          const items = parseListItems(out)
          if (items.length > 0) {
            previewLines.push(`该数据源可查明细的数据模型（直接用 id 调 query_records 取明细）：`)
            for (const it of items.slice(0, 15)) {
              previewLines.push(`  - 模型 id="${it.id}"${it.description ? `：${it.description}` : ''}`)
            }
            if (items.length > 15) previewLines.push(`  …共 ${items.length} 个，已列前 15 个`)
          }
        } catch {
          /* 预取失败不阻塞 */
        }
      }
      if (previewLines.length > 0) catalogLines.push(previewLines.join('\n'))
    }

    // 3) 全部源连不上 -> 数据源卡点卡
    if (whitelist.size === 0) {
      ctx.report(listErrors.join('；') || '配置的数据源都连不上')
      return { kind: 'suspend', reason: SUSPEND_TAGS.datasourceDown }
    }

    const toolsCatalog = catalogLines.join('\n')

    // 4) 取数规划（planner 角色）
    ctx.report('正在规划要取哪些数据…')
    let calls: DataFetchCall[]
    try {
      const raw = await callDataFetchPlan(
        this.llm,
        text,
        answersSummary,
        toolsCatalog,
        (chars: number) => ctx.report(`已规划 ${chars} 字`),
        ctx.signal
      )
      calls = normalizeDataFetchCalls(raw, whitelist)
    } catch (err) {
      // 规划 LLM 失败：按 datasource_down 处理（保留与 orchestrator 一致的卡点语义）
      ctx.report(err instanceof Error ? err.message : '取数规划失败')
      return { kind: 'suspend', reason: SUSPEND_TAGS.datasourceDown }
    }
    ctx.report(calls.length > 0 ? `要取 ${calls.length} 批数据` : '这版用演示数据就够用')

    // 6) 规划结论：不需要真实数据 -> 用演示数据（dataBlock 为空串）
    if (calls.length === 0) {
      return {
        kind: 'done',
        output: {
          usage: [],
          dataSourcesUsed: [],
          summary: '用演示数据'
        },
        refs: { dataBlock: '' }
      }
    }

    // 7) 逐个执行取数调用（最多 2 轮纠错）
    const results: Array<{ source: string; purpose: string; text: string; tool?: string }> = []
    const usedMap = new Map<string, DataUseEntry>()
    const sigOf = (c: DataFetchCall) => `${c.sourceId}|${c.tool}|${c.purpose || ''}`
    let attemptsLog: Array<{ call: DataFetchCall; result: string }> = []

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) {
        // 纠错轮：把上一轮执行结果反馈给规划 LLM，让它输出需要重试的 calls
        ctx.report(round === 1 ? '有些数据没取到，正在按数据源的提示重新取…' : '再次尝试取数…')
        let retryCalls: DataFetchCall[] = []
        try {
          const raw = await callDataFetchPlan(
            this.llm,
            text,
            answersSummary,
            toolsCatalog,
            (chars: number) => ctx.report(`已规划 ${chars} 字`),
            ctx.signal,
            formatAttempts(attemptsLog)
          )
          retryCalls = normalizeDataFetchCalls(raw, whitelist)
        } catch {
          // 纠错规划失败：用已有的继续
        }
        if (retryCalls.length === 0) break // LLM 说不用再试，结束闭环
        calls = retryCalls
        attemptsLog = [] // 新一轮重新记录
      }

      for (const [i, call] of calls.entries()) {
        const source = sourceById.get(call.sourceId)
        const sourceName = source?.name || source?.url || call.sourceId
        ctx.report(`正在取数 ${i + 1}/${calls.length}：${call.purpose || call.tool}…`)
        try {
          const out = await this.mcp.callTool(source as McpDataSource, call.tool, call.args)
          attemptsLog.push({ call, result: out })
          results.push({ source: sourceName, purpose: call.purpose || call.tool, text: out, tool: call.tool })
          usedMap.set(sigOf(call), toDataUseEntry(sourceName, call, normalizeToolResult(out, call.tool)))
        } catch (err) {
          const msg = err instanceof Error ? err.message : `取「${call.purpose || call.tool}」失败了`
          attemptsLog.push({ call, result: msg })
          usedMap.set(sigOf(call), toFailedEntry(sourceName, call, msg))
        }
      }

      // 首轮执行后判断要不要进纠错轮（启发式：含 error / 空数组 / 空对象）
      if (round === 0) {
        const needsRetry = attemptsLog.some((a) => {
          const head = a.result.slice(0, 800)
          return /"error"\s*:/.test(head) || /\[\s*\]/.test(head) || /^\s*\{\s*\}\s*$/.test(a.result.trim())
        })
        if (!needsRetry) break // 都成功且非空，不必进纠错轮
      }
      // 纠错轮后不再继续（已用尽 MAX_ROUNDS）
    }

    // 8) 全部失败 -> 数据源卡点卡
    if (results.length === 0) {
      ctx.report('数据源没有返回数据')
      return { kind: 'suspend', reason: SUSPEND_TAGS.datasourceDown }
    }

    // 9) 成功：拼数据块，存 refs.dataBlock（截断文本，给 LLM 看形状）+ refs.dataFile（完整结构化数组的 JSON 串，落盘用）
    const block = buildDataBlock(results)
    const dataFileJson = JSON.stringify(buildDataItems(results))
    const usage = calls.map((c) => ({ purpose: c.purpose, panel: c.panel || c.purpose }))
    ctx.report(
      `真实数据取到了（${results.map((r) => `「${r.purpose}」`).join('、')}），编写页面时直接用这些真数据。`
    )

    return {
      kind: 'done',
      output: {
        usage,
        dataSourcesUsed: [...usedMap.values()],
        summary: `取到 ${results.length} 批数据`
      },
      refs: { dataBlock: block, dataFile: dataFileJson }
    }
  }
}
