/**
 * LoopEngine -- 通用循环引擎实例。
 *
 * 只实现 Loop 核心概念：状态机推进、挂起/恢复、记忆存取、超时中止。
 * 不认识任何业务概念（不知道 planner/fetch/coder，不知道大屏）。
 *
 * 内部方法（run/selectEdge/setNodeOutput/finish）全部 private：
 * 业务只能通过 handleEvent（驱动）+ getGraphState（读记忆）+ 回调（onCommit/onNodeComplete）交互。
 * 这是架构性约束：业务在节点执行链路上拿不到引擎引用（只有只读 NodeContext），
 * 无法绕过转移表。引擎规则靠"声明式接入 + private 内部 + 执行器隔离"保证。
 */
import type { EngineState, GraphState, NodeId } from './types'
import type { NodeExecutor, NodeContext, NodeResult } from './node-executor'
import type { ResumeTable } from './definition'
import type { LoopEvent } from './events'
import {
  createGraphState,
  cloneGraphState,
  setNodeStatus,
  setNodeOutput,
  selectEdge
} from './graph-state'

/** 业务声明的一切，传给 createLoop，引擎接管 */
export interface LoopConfig {
  /** 流程定义：节点 + edges + guards */
  definition: import('./types').FlowDefinition
  /** 恢复表 */
  resume: ResumeTable
  /** 各节点执行器（业务实现，自己持有依赖） */
  executors: Record<NodeId, NodeExecutor>
  /** 流程完成时回调（业务实现"怎么存"，引擎决定"何时存"） */
  onCommit?: (graphState: GraphState) => Promise<void> | void
  /** 节点完成时回调（可选，业务用于 UI 更新/事件发射）。suspendPayload 在挂起时携带执行器数据 */
  onNodeComplete?: (nodeId: NodeId, graphState: GraphState, suspendPayload?: Record<string, unknown>) => void
  /** 节点进度回调（可选，业务用于实时进展展示，如"正在编写页面…已生成 2340 字"） */
  onProgress?: (nodeId: NodeId, detail: string) => void
  /** 单节点执行超时上限（毫秒）；默认 20 分钟。超时 abort 传给执行器的 signal */
  stepTimeoutMs?: number
}

export class LoopEngine {
  private graphState: GraphState | null = null
  private config: LoopConfig
  private state: EngineState = 'idle'
  /** 当前节点执行的中止器（看门狗超时时 abort） */
  private currentAbort: AbortController | null = null
  /** 看门狗定时器 */
  private watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(config: LoopConfig) {
    this.config = config
  }

  /** 引擎状态（业务映射到展示态） */
  getState(): EngineState {
    return this.state
  }

  /** 获取图状态快照（深拷贝，onCommit/回退时用；引擎未启动时返回 null） */
  getGraphState(): GraphState | null {
    return this.graphState ? cloneGraphState(this.graphState) : null
  }

  /**
   * 更新某节点的 output/refs 字段（resume 前业务注入数据用，如澄清答案、清空数据块）。
   * 直接写引擎内部 graphState（不是拷贝），resume 后执行器从 ctx.graphState 能读到。
   * 仅在 suspended 态调用（resume 前注入）。
   */
  patchNode(nodeId: NodeId, patch: { output?: Record<string, unknown>; refs?: Record<string, string> }): void {
    if (!this.graphState) return
    const node = this.graphState.nodes[nodeId]
    if (!node) return
    if (patch.output) node.output = { ...node.output, ...patch.output }
    if (patch.refs) node.refs = { ...node.refs, ...patch.refs }
  }

  /**
   * 事件入口：业务/适配层调用，引擎自动决定如何响应。
   * 业务不直接调 start/resume/restore，只发事件。
   */
  async handleEvent(event: LoopEvent): Promise<void> {
    switch (event.kind) {
      case 'start':
        await this.handleStart(event.initialNode)
        break
      case 'resume':
        await this.handleResume()
        break
      case 'restore':
        await this.handleRestore(event.graphState)
        break
    }
  }

  /* ============================== 事件处理 ============================== */

  private async handleStart(initialNode: NodeId): Promise<void> {
    this.graphState = createGraphState(this.config.definition, initialNode)
    this.state = 'running'
    await this.run()
  }

  private async handleResume(): Promise<void> {
    if (!this.graphState) return
    const reason = this.graphState.awaiting
    if (!reason) return
    const point = this.config.resume.resume[reason]
    if (!point) return
    this.graphState.awaiting = null
    point.before?.(this)
    this.graphState.current = point.node
    this.state = 'running'
    await this.run()
  }

  private async handleRestore(graphState: GraphState): Promise<void> {
    this.graphState = cloneGraphState(graphState)
    if (this.graphState.awaiting) {
      this.state = 'suspended'
    } else if (this.graphState.current) {
      this.state = 'running'
      await this.run()
    } else {
      this.state = 'idle'
    }
  }

  /* ============================== 主循环 ============================== */

  /**
   * 主循环：按 edges+guard 选边推进，直到挂起/失败/完成。
   * 节点只产出 output，路由由 guard 判断（引擎职责），不查 next 表。
   */
  private async run(): Promise<void> {
    if (!this.graphState) return
    while (true) {
      const nodeId = this.graphState.current
      const executor = this.config.executors[nodeId]
      if (!executor) {
        console.log(`[loop-engine] run break: 节点 ${nodeId} 无执行器`)
        break
      }

      setNodeStatus(this.graphState, nodeId, 'active')
      console.log(`[loop-engine] ▶ 执行节点 ${nodeId}`)
      const result = await this.executeWithWatchdog(nodeId, executor)
      console.log(`[loop-engine] ◀ ${nodeId} 返回 ${result.kind}${result.kind === 'suspend' ? '(' + (result as any).reason + ')' : ''}`)

      switch (result.kind) {
        case 'done':
          setNodeOutput(this.graphState, nodeId, result.output, result.refs)
          setNodeStatus(this.graphState, nodeId, 'done')
          // 先选边 + 推进 current，再通知业务层——
          // 这样 onNodeComplete 推出的 graph 快照里 current 已指向下一节点，
          // 调试面板的指针不会"慢一个节点"（否则 current 还停在刚完成的节点）
          const edge = selectEdge(this.graphState, nodeId)
          console.log(`[loop-engine] ${nodeId} done -> selectEdge=${edge ? edge.to + (edge.guard ? '(guard:' + edge.guard + ')' : '') : 'null(结束→finish)'}`)
          if (!edge) {
            // 流程结束：current 不再推进，通知后走 finish
            this.safeNotify(nodeId, cloneGraphState(this.graphState))
            await this.finish()
            return
          }
          this.graphState.current = edge.to
          // 提前把下一节点标 active，让 graph 快照的状态色跟上指针（否则 current 指向的节点还是 pending 色）
          setNodeStatus(this.graphState, edge.to, 'active')
          // current 已到下一节点，通知业务层（graph 快照的指针和状态色都是准的）
          this.safeNotify(nodeId, cloneGraphState(this.graphState))
          break

        case 'suspend':
          this.graphState.awaiting = result.reason
          this.state = 'suspended'
          // suspend 也要通知业务层（发挂起卡片），携带 payload（如澄清问题）
          this.safeNotify(nodeId, cloneGraphState(this.graphState), result.payload)
          return

        case 'failed':
          setNodeStatus(this.graphState, nodeId, 'failed')
          // 存失败原因到 output.error，让业务层（handleNodeComplete）能读到具体错误信息发失败卡片
          const failErr = (result as { error?: Error }).error
          setNodeOutput(this.graphState, nodeId, { error: failErr instanceof Error ? failErr.message : String(failErr ?? '') })
          this.state = 'blocked'
          // failed 也要通知业务层（发失败卡片）
          this.safeNotify(nodeId, cloneGraphState(this.graphState))
          return
      }
    }
  }

  /**
   * 安全调用业务回调：隔离其异常，仅打日志，绝不向上抛。
   * 引擎状态机推进不依赖业务回调成功（回调是"旁路通知"，如发 SSE、落盘、更新 UI），
   * 回调失败不能让 run() 的 Promise reject 导致整条流程静默卡死。
   */
  private safeNotify(nodeId: NodeId, graphState: GraphState, suspendPayload?: Record<string, unknown>): void {
    try {
      this.config.onNodeComplete?.(nodeId, graphState, suspendPayload)
    } catch (err) {
      console.error(`[loop-engine] onNodeComplete 回调异常（已隔离，不阻断推进）node=${nodeId}:`, err)
    }
  }

  /** 执行单节点，带看门狗超时中止 */
  private async executeWithWatchdog(nodeId: NodeId, executor: NodeExecutor): Promise<NodeResult> {
    const ctl = new AbortController()
    this.currentAbort = ctl
    const timeout = this.config.stepTimeoutMs ?? 20 * 60 * 1000
    this.watchdog = setTimeout(() => ctl.abort(), timeout)

    const ctx: NodeContext = {
      graphState: this.graphState!,
      report: (detail: string) => {
        // 进度回调异常隔离：不能让"更新 UI"失败把执行器拖垮（被外层 try 当成节点失败）
        try {
          this.config.onProgress?.(nodeId, detail)
        } catch (err) {
          console.error(`[loop-engine] onProgress 回调异常（已隔离）node=${nodeId}:`, err)
        }
      },
      signal: ctl.signal
    }

    try {
      return await executor.execute(ctx)
    } catch (err) {
      // 看门狗超时 -> abort 触发执行器抛错，归为 failed
      return { kind: 'failed', error: err instanceof Error ? err : new Error(String(err)) }
    } finally {
      if (this.watchdog) {
        clearTimeout(this.watchdog)
        this.watchdog = null
      }
      this.currentAbort = null
    }
  }

  /** 流程完成：触发 onCommit（引擎决定何时存，业务决定怎么存） */
  private async finish(): Promise<void> {
    console.log(`[loop-engine] finish() 触发 onCommit，current=${this.graphState?.current}`)
    this.state = 'idle'
    if (this.config.onCommit && this.graphState) {
      await this.config.onCommit(cloneGraphState(this.graphState))
      console.log(`[loop-engine] onCommit 完成`)
    }
  }
}
