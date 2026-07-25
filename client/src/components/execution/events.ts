/**
 * 执行面板发出的跨组件轻量事件（无第三方依赖，走 window CustomEvent）。
 * 目前只有一个：卡点行动区点「去回答」时，通知对话区滚动定位到对应卡片。
 * 对话区（chat agent）监听方式：
 *   window.addEventListener(LOCATE_MESSAGE_EVENT, (e) => {
 *     const { messageId } = (e as CustomEvent<{ messageId: string }>).detail
 *     // 滚动定位到 messageId 对应的消息卡片
 *   })
 */
export const LOCATE_MESSAGE_EVENT = 'ai-dashboard:locate-message'

/** 通知对话区滚动定位到某条消息（澄清卡片 / 问题处理卡片） */
export function emitLocateMessage(messageId: string): void {
  window.dispatchEvent(
    new CustomEvent<{ messageId: string }>(LOCATE_MESSAGE_EVENT, { detail: { messageId } })
  )
}
