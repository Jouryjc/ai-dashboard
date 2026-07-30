/**
 * 通用事件 -- 业务/适配层把用户操作转成事件传给引擎，引擎自动决定 start/resume/restore。
 *
 * 业务方不实现路由逻辑，只调用 engine.handleEvent(event)。
 * 引擎收到事件后，自己按 graphState.current/awaiting 决定怎么响应。
 *
 * 适配层（server 侧，只写一次）负责"判断该发哪种事件"：
 *   - 有版本就 restore（载入记忆继续），没版本就 start（启动新流程）
 *   - 用户答题/选卡后发 resume
 *   - 回退发 restore（载入目标版本记忆）
 */
import type { GraphState, NodeId } from './types'

export type LoopEvent =
  /** 启动新流程：设 initialNode 为 current，进入主循环 */
  | { kind: 'start'; initialNode: NodeId }
  /** 恢复：查 ResumeTable -> 清 awaiting -> 移 current -> 进主循环 */
  | { kind: 'resume' }
  /** 载入历史快照：回退/重启恢复时，从外部载入 graphState 继续 */
  | { kind: 'restore'; graphState: GraphState }
