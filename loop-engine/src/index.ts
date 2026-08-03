/**
 * loop-engine 包出口 -- 声明式接入入口。
 *
 * 业务方只需声明"步骤+关系+怎么存"，引擎接管调度并校验声明完整性。
 * 借鉴 LangGraph compile：创建时校验，漏了就报错，不靠业务自觉。
 */
import { LoopEngine, type LoopConfig } from './engine'
import type { FlowDefinition, NodeId } from './types'
import type { ResumeTable } from './definition'
import type { NodeExecutor } from './node-executor'

export { LoopEngine } from './engine'
export type { LoopConfig } from './engine'
export type {
  GraphCheckpoint,
  GraphState,
  NodeState,
  NodeOutput,
  FlowDefinition,
  Edge,
  NodeId,
  Tag,
  EngineState
} from './types'
export type { ResumeTable, ResumePoint } from './definition'
export type { NodeExecutor, NodeContext, NodeResult } from './node-executor'
export type { LoopEvent } from './events'
export {
  createGraphCheckpoint,
  createGraphState,
  cloneGraphState,
  restoreGraphState
} from './graph-state'

/**
 * 创建 Loop 实例（声明式接入）。
 *
 * 创建时校验声明完整性（借鉴 LangGraph compile）：
 *   - edges 引用的 from/to 必须在 nodes 里
 *   - edges 引用的 guard 名必须在 guards 表里
 *   - executors 必须覆盖所有 nodes
 *   - resume 表的 node 必须在 nodes 里（'current' 特殊值除外）
 * 校验失败直接抛错。
 */
export function createLoop(config: LoopConfig): LoopEngine {
  validateConfig(config)
  return new LoopEngine(config)
}

/** 校验配置完整性（创建时调用，失败抛错） */
function validateConfig(config: LoopConfig): void {
  const errors: string[] = []
  const def: FlowDefinition = config.definition
  const nodeIds = new Set<NodeId>(def.nodes.map((n) => n.id))

  // 1. edges 引用的 from/to 必须在 nodes 里
  for (const e of def.edges) {
    if (!nodeIds.has(e.from)) errors.push(`edge from "${e.from}" 不在 nodes 里`)
    if (!nodeIds.has(e.to)) errors.push(`edge to "${e.to}" 不在 nodes 里`)
    if (e.from === e.to) errors.push(`edge "${e.from}" -> "${e.to}" 是自环（不允许）`)
  }

  // 2. edges 引用的 guard 名必须在 guards 表里
  const guardNames = new Set(Object.keys(def.guards ?? {}))
  for (const e of def.edges) {
    if (e.guard && !guardNames.has(e.guard)) {
      errors.push(`edge "${e.from}" -> "${e.to}" 引用了未定义的 guard "${e.guard}"`)
    }
  }

  // 3. executors 必须覆盖所有 nodes
  for (const n of def.nodes) {
    if (!config.executors[n.id]) {
      errors.push(`节点 "${n.id}" 没有对应的 executor`)
    }
  }

  // 4. resume 表的 node 必须在 nodes 里（'current' 是特殊值，表示回到卡住时的节点）
  const resumeTable: ResumeTable = config.resume
  for (const [tag, point] of Object.entries(resumeTable.resume)) {
    if (point.node !== 'current' && !nodeIds.has(point.node)) {
      errors.push(`resume 表的 "${tag}" 指向了不存在的节点 "${point.node}"`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`createLoop 校验失败：\n  - ${errors.join('\n  - ')}`)
  }
}
