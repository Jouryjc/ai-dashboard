/**
 * business-app 修复恢复策略。
 *
 * 修复是否耗尽由 Loop 的显式终止状态决定，不能从已执行策略数量猜测；部分策略可能因
 * 当前失败类型不适用而被跳过。重新生成也按 flowVersion 限制为同一流程版本至多一次，
 * 避免在输入、证据和实现均未变化时把随机重跑包装成“继续修复”。
 */

export const BUSINESS_APP_REPAIR_EXHAUSTED_REASON = 'idux-quality-strategies-exhausted'

export const BUSINESS_APP_REPAIR_STRATEGIES = [
  'deterministic-repair',
  'model-source-repair',
  'targeted-regeneration',
  'evidence-expanded-replan'
] as const

export type BusinessAppRepairStrategy = typeof BUSINESS_APP_REPAIR_STRATEGIES[number]
export type BusinessAppRepairStatus = 'available' | 'exhausted'
export type BusinessAppRecoveryMode = 'continue-repair' | 'regenerate' | 'terminal'

/** 计算恢复动作所需的最小持久化状态，兼容旧会话缺少显式状态字段的情况。 */
export interface BusinessAppRepairProgress {
  repairStatus?: BusinessAppRepairStatus
  strategiesTried?: string[]
  lastFailure?: string | null
  lastRegenerationFlowVersion?: number | null
  checkpoint?: { awaiting?: string | null } | null
}

/** 清理旧会话中的未知或重复策略，只保留受控策略枚举。 */
export function normalizeBusinessAppRepairStrategies(values: string[] | undefined): BusinessAppRepairStrategy[] {
  const allowed = new Set<string>(BUSINESS_APP_REPAIR_STRATEGIES)
  return [...new Set(values ?? [])].filter((value): value is BusinessAppRepairStrategy => allowed.has(value))
}

/**
 * 归一化修复终止状态。
 *
 * checkpoint 是新流程的首选事实源；错误文本只用于迁移已经落盘、但尚无 repairStatus 的旧会话。
 */
export function normalizeBusinessAppRepairStatus(progress: BusinessAppRepairProgress): BusinessAppRepairStatus {
  if (progress.repairStatus === 'available' || progress.repairStatus === 'exhausted') {
    return progress.repairStatus
  }
  if (
    progress.checkpoint?.awaiting === BUSINESS_APP_REPAIR_EXHAUSTED_REASON ||
    /(?:全部自主修复策略已经执行|自主修复策略已全部尝试|已依次尝试.+仍未通过)/u.test(progress.lastFailure ?? '')
  ) {
    return 'exhausted'
  }
  return 'available'
}

/** 返回唯一可执行的恢复模式，调用方据此生成卡片并校验历史按钮。 */
export function businessAppRecoveryMode(
  progress: BusinessAppRepairProgress,
  flowVersion: number
): BusinessAppRecoveryMode {
  if (normalizeBusinessAppRepairStatus(progress) !== 'exhausted') return 'continue-repair'
  return progress.lastRegenerationFlowVersion === flowVersion ? 'terminal' : 'regenerate'
}
