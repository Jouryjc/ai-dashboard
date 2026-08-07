/**
 * 节点执行器接口 -- 通用，业务实现。
 *
 * 引擎只调 execute()，不关心节点干什么。业务实例实现此接口并注入引擎。
 *
 * 执行器自己持有业务依赖（LLM/MCP/存储等），构造时注入，不经引擎中转。
 * 引擎只提供调度相关的 context（记忆/进度/中止）。
 *
 * 节点是状态变换器，只产出 output，不参与路由（借鉴 LangGraph/XState）。
 * 路由判断由 FlowDefinition.guards 配置，引擎按 edges 声明顺序匹配。
 */
import type { GraphState, NodeOutput } from './types'

export interface NodeExecutor {
  execute(ctx: NodeContext): Promise<NodeResult>
}

/** 引擎给执行器的上下文（只有调度相关，无业务能力） */
export interface NodeContext {
  /**
   * 读取图状态（读上游节点 output、当前 current 等）。
   * 只读视图：执行器不应直接修改，产出通过 NodeResult 返回给引擎写入。
   */
  graphState: GraphState
  /** 汇报进度（业务定义如何展示，如发 SSE 事件） */
  report: (detail: string) => void
  /** 中止信号（引擎看门狗超时时 abort，执行器应响应中止） */
  signal: AbortSignal
}

/**
 * 执行结果。节点只产出，不参与路由：
 *   - done：返回产出（output/refs），下一个节点由引擎查 edges+guard 决定
 *   - suspend：返回 reason 存入 awaiting，恢复时查 ResumeTable；可选 payload 携带挂起相关数据
 *   - failed：返回错误，引擎置 blocked 态
 */
export type NodeResult =
  | { kind: 'done'; output?: NodeOutput; refs?: Record<string, string> }
  | {
      kind: 'suspend'
      reason: string
      /** 引擎挂起前持久化的节点记忆。 */
      output?: NodeOutput
      /** 引擎挂起前持久化的产物引用。 */
      refs?: Record<string, string>
      /** 仅通过 onNodeComplete 发送、不进入检查点的临时界面数据。 */
      payload?: Record<string, unknown>
    }
  | { kind: 'failed'; error: Error }
