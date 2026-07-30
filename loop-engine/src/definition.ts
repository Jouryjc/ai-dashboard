/**
 * 恢复表：声明每种挂起标记恢复时从哪继续。
 *
 * 只管"逆向恢复"（挂起后跳回某节点重跑），不管正向转移 --
 * 正向转移由 FlowDefinition.edges 的 guard 承担（见 types.ts）。
 *
 * 为什么恢复点不能由执行器运行时返回、要静态配置？
 * 因为重启恢复时执行器不在了，只有 graphState.awaiting 里存的 Tag，
 * 引擎要靠它查这张表重建恢复点。所以恢复点必须是静态可查的。
 */
import type { NodeId } from './types'
import type { LoopEngine } from './engine'

export interface ResumeTable {
  /** 挂起标记 -> 恢复点 */
  resume: Record<string, ResumePoint>
}

export interface ResumePoint {
  /** 恢复后从哪个节点继续 */
  node: NodeId
  /**
   * 恢复前的前置动作（业务自定义，如清理 awaiting 相关状态）。
   * 传入 engine 引用供业务做必要的图状态调整。
   */
  before?: (engine: LoopEngine) => void
}
