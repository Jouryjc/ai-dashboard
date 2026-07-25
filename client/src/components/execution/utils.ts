/**
 * 执行面板通用小工具：时间文案全部用大白话。
 */

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / x 天前 */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  return `${d} 天前`
}

/** 耗时："42 秒" / "1 分 42 秒" / "1 小时 3 分" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs > 0 ? `${m} 分 ${rs} 秒` : `${m} 分钟`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 时刻："09:42"（协助动作流水用） */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
