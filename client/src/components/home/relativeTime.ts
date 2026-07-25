/**
 * 最近修改时间的大白话写法（首页卡片用）：
 *   刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 上周 / N 周前 / N 个月前 / 很久以前
 */

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 14) return '上周'
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} 周前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return '很久以前'
}
