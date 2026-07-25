/**
 * 对话区时间工具：时间分组分隔条用的格式化与判断（大白话，无技术术语）。
 * 规则：
 *  - 两条消息间隔 ≤ 5 分钟且同一天 → 不加分隔条；
 *  - 分隔条文案：今天 上午 10:23 / 昨天 下午 3:02 / 7月24日 上午 9:12 / 2025年12月3日 晚上 8:40。
 */

/** 两条消息之间是否需要插入时间分隔条 */
export function needDivider(prevTs: number | null, nextTs: number): boolean {
  if (prevTs === null) return true
  const FIVE_MIN = 5 * 60 * 1000
  if (nextTs - prevTs > FIVE_MIN) return true
  const a = new Date(prevTs)
  const b = new Date(nextTs)
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  )
}

function hourLabel(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  return '晚上'
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** 分隔条文案（今天/昨天/今年/跨年四档） */
export function formatDivider(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const n = new Date(now)
  const time = `${hourLabel(d.getHours())} ${pad(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12)}:${pad(d.getMinutes())}`

  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / (24 * 60 * 60 * 1000))

  if (dayDiff === 0) return `今天 ${time}`
  if (dayDiff === 1) return `昨天 ${time}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}
