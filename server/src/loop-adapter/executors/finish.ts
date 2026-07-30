/**
 * FinishExecutor -- 生成预览（收尾）节点执行器。
 *
 * 对应原 orchestrator 的 commitVersion。本执行器不做任何事：引擎主循环在 finish
 * done 后 selectEdge 返回 null（finish 无出边），触发 engine.finish() 调 onCommit 回调，
 * 真正的产物存储（写 preview、版本元数据、发 SSE）由 adapter 的 onCommit 回调承担。
 *
 * 所以这里只返回 done，标记已提交。
 */
import type { NodeExecutor, NodeContext, NodeResult } from '../../../../loop-engine/src'

export class FinishExecutor implements NodeExecutor {
  constructor() {}

  async execute(_ctx: NodeContext): Promise<NodeResult> {
    // 无出边：done 后引擎 selectEdge 返回 null -> finish() -> onCommit
    return { kind: 'done', output: { committed: true } }
  }
}
