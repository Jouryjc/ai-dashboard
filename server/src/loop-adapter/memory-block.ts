/**
 * GraphState 回灌文本构造 -- 各 Coder 执行器调用前从 graphState 构造流程记忆。
 *
 * 解决"数据生成"问题：Coder 能看到取数用途映射 + 模板匹配理由 + 需求理解，
 * 不再硬编码。每个 LLM 调用前把这段记忆拼进 prompt。
 */
import type { GraphState } from '../../../loop-engine/src'
import { CREATE_NODES, EDIT_NODES } from './flow-definition'

/** 从 graphState 取节点 output（兜底空对象） */
function outputOf(gs: GraphState, nodeId: string): Record<string, unknown> {
  return (gs.nodes[nodeId]?.output ?? {}) as Record<string, unknown>
}

/**
 * 构造流程记忆文本块，注入 Coder/修复 prompt。
 * 只含决策摘要（轻量），产物本体按需通过 refs 取。
 */
export function buildMemoryBlock(gs: GraphState): string {
  const lines: string[] = ['## 流程记忆（供你理解整体设计意图，数值运行时从 data.json 读取，不要写死）']

  // 需求理解（planner 节点）
  const planner = outputOf(gs, CREATE_NODES.planner)
  if (planner.analysis) lines.push(`- 需求理解：${planner.analysis}`)
  if (planner.answersSummary) lines.push(`- 澄清确认：${planner.answersSummary}`)

  // 模板匹配（match 节点）
  const match = outputOf(gs, CREATE_NODES.match)
  if (match.layoutReason) {
    lines.push(`- 布局选择：${match.layoutReason}`)
  } else if (match.useTemplate === false) {
    lines.push('- 布局选择：无匹配模板，按需求自定义')
  }

  // 数据用途映射（fetch 节点）
  const fetch = outputOf(gs, CREATE_NODES.fetch)
  const usage = fetch.usage
  if (Array.isArray(usage) && usage.length > 0) {
    const mapping = usage
      .map((u: unknown) => {
        const item = u as { purpose?: string; panel?: string }
        return `${item.purpose ?? '?'}->${item.panel ?? '?'}`
      })
      .join('、')
    lines.push(`- 数据用途映射：${mapping}`)
  }

  // 修复历史（repair 节点）
  const repair = outputOf(gs, CREATE_NODES.repair)
  if (repair.attempt) {
    lines.push(`- 修复历史：已尝试 ${repair.attempt} 次`)
  }

  if (lines.length === 1) return '' // 只有标题行，无内容
  return lines.join('\n')
}

/** 构造 edit 流程的记忆（复用 create 的各节点 output） */
export function buildEditMemoryBlock(gs: GraphState): string {
  // edit 流程的 graphState 是从 create 版本 restore 的，各节点 output 都在
  return buildMemoryBlock(gs)
}
