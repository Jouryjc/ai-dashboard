/**
 * 共享类型 -- 全部通用，零业务知识。
 *
 * 引擎不认识任何具体节点名（planner/fetch/coder 等）、不认识任何挂起标记值
 * （clarification/problem/llm 等）。这些都是业务声明的不透明值，引擎只存不解释。
 */

/** 节点 id（引擎不认识其含义，是 opaque 字符串） */
export type NodeId = string

/**
 * 挂起标记（引擎不解释其含义）。
 *
 * suspend 时作为 reason 存入 graphState.awaiting，重启恢复时匹配 ResumeTable 选恢复点。
 * 值由业务定义（如大屏的 'clarification'/'problem'/'llm'），引擎只匹配不解释。
 */
export type Tag = string

/** 节点产出（业务语义，引擎不解释：可能是决策、结果总结、重要信息等） */
export interface NodeOutput {
  [key: string]: unknown
}

/**
 * 流程在某一刻的完整图状态。
 *
 * - 嵌入业务版本时 = 已提交的不可变快照（onCommit 时 freeze）
 * - 引擎运行态 = 未提交的当前态（随推进变化，流程完成时 freeze）
 * - 只存图状态 + 节点产出 + 产物引用，绝不存产物本体
 */
export interface GraphState {
  /** 流程定义（业务声明：有哪些节点、允许的转移、guard 实现） */
  definition: FlowDefinition
  /** 各节点当前状态（图的核心：每个节点 status + 产出 + 产物引用） */
  nodes: Record<NodeId, NodeState>
  /** 流程当前停在哪个节点（流程指针；推进/挂起/恢复都看它） */
  current: NodeId
  /** 挂起标记（存执行器返回的 reason，重启恢复时用它查 ResumeTable）；null = 正在推进或已结束 */
  awaiting: Tag | null
}

/**
 * 流程定义：节点 + 带 guard 的边 + guard 实现。
 *
 * 边同时承担"拓扑"和"正向转移"职责（合一，无冗余）：
 *   - 拓扑：from->to 是允许的连接
 *   - 转移：guard 是路由判断的引用名，引擎按声明顺序匹配首个 guard 为真（或无 guard）的边
 *
 * 借鉴 XState 守卫模式：节点只管产出 output，不参与路由；
 * 路由判断（guard 实现）独立于节点，单独配置。
 */
export interface FlowDefinition {
  nodes: Array<{ id: NodeId; name: string }>
  edges: Array<Edge>
  /** guard 实现：路由判断函数，按名引用；与节点执行器分离 */
  guards?: Record<string, (graphState: GraphState) => boolean>
}

/** 一条边：from->to 的连接，可选 guard 控制条件转移 */
export interface Edge {
  from: NodeId
  to: NodeId
  /** guard 引用名；缺省 = 无条件边（兜底）。引擎按 edges 声明顺序，取首个 guard 为真或无 guard 的边 */
  guard?: string
}

/** 单个节点在某一刻的状态 */
export interface NodeState {
  /** 节点运行态：未开始 / 进行中 / 已完成 / 失败 */
  status: 'pending' | 'active' | 'done' | 'failed'
  /** 节点产出（业务语义，引擎不解释） */
  output?: NodeOutput
  /** 指向产物层的引用（键名由业务定，值是产物定位串；引擎不解析） */
  refs?: Record<string, string>
}

/** 引擎内部状态（业务可映射到自己的展示态） */
export type EngineState = 'idle' | 'running' | 'suspended' | 'blocked'
