/**
 * GraphState 操作 -- 引擎内部的图状态读写工具。
 *
 * 引擎是 graphState 的唯一读写者：执行器通过 NodeContext 只读访问，
 * 产出通过 NodeResult 返回，引擎据此写入对应节点的 NodeState。
 */
import type { FlowDefinition, GraphState, NodeId, NodeOutput, NodeState } from './types'

/** 按 FlowDefinition 初始化一个全 pending 的图状态 */
export function createGraphState(definition: FlowDefinition, initialNode: NodeId): GraphState {
  const nodes: Record<NodeId, NodeState> = {}
  for (const n of definition.nodes) {
    nodes[n.id] = { status: 'pending' }
  }
  return {
    definition,
    nodes,
    current: initialNode,
    awaiting: null
  }
}

/** 设置节点运行态 */
export function setNodeStatus(gs: GraphState, nodeId: NodeId, status: NodeState['status']): void {
  const node = gs.nodes[nodeId]
  if (node) node.status = status
}

/** 写入节点产出（done 时引擎调用） */
export function setNodeOutput(
  gs: GraphState,
  nodeId: NodeId,
  output?: NodeOutput,
  refs?: Record<string, string>
): void {
  const node = gs.nodes[nodeId]
  if (!node) return
  if (output !== undefined) node.output = output
  if (refs !== undefined) node.refs = { ...node.refs, ...refs }
}

/**
 * 按 guard 选边（借鉴 XState 守卫模式）。
 * 取 from 的候选边，按声明顺序找首个 guard 为真（或无 guard 兜底）的边。
 */
export function selectEdge(gs: GraphState, from: NodeId): import('./types').Edge | null {
  const candidates = gs.definition.edges.filter((e) => e.from === from)
  if (candidates.length === 0) return null
  const guards = gs.definition.guards
  return (
    candidates.find((e) => {
      if (!e.guard) return true // 无 guard = 无条件兜底
      return guards?.[e.guard]?.(gs) ?? false
    }) ?? null
  )
}

/**
 * 深拷贝图状态（快照导出用，确保外部拿到不可变副本）。
 *
 * definition 是不可变配置（含 guard 函数，structuredClone 无法克隆函数），
 * 不需要拷贝，直接共享引用。只拷贝可变部分：nodes / current / awaiting。
 */
export function cloneGraphState(gs: GraphState): GraphState {
  return {
    definition: gs.definition,
    nodes: structuredClone(gs.nodes),
    current: gs.current,
    awaiting: gs.awaiting
  }
}
