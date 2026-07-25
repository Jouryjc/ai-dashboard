/**
 * 对话区数据源（左栏）：消息流 + 发送 + 卡片应答。
 * 用法：
 *   const chat = useChatStore()
 *   chat.messages                    // 渲染消息流（按 kind 分五种气泡/卡片）
 *   chat.latestClarification         // 未回答的澄清卡片（行动区"去回答"定位用）
 *   chat.activeProblem               // 未选择的问题处理卡片
 *   await chat.send('帮我做一个服务器监控大屏')
 *   await chat.answerClarification(msg.id, [{ questionId, optionId, customText: '' }])
 *   await chat.chooseOption(opt.id)  // 问题卡片与右栏行动区都调这个
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type {
  ChatMessage,
  ClarificationAnswer,
  ClarificationMessage,
  ProblemMessage
} from '../types'

export const useChatStore = defineStore('chat', () => {
  /* ---------- state ---------- */
  /** 当前大屏 ID（未打开工作台 = null） */
  const dashboardId = ref<string | null>(null)
  /** 消息流（时间升序） */
  const messages = ref<ChatMessage[]>([])
  /** 发送中（仅表示网络往返，输入框永不锁定） */
  const sending = ref(false)

  /* ---------- getters ---------- */
  /** 最近一张未回答的澄清卡片（没有 = null） */
  const latestClarification = computed<ClarificationMessage | null>(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.kind === 'clarification' && !m.answered) return m
    }
    return null
  })
  /** 最近一张未选择的问题处理卡片（没有 = null） */
  const activeProblem = computed<ProblemMessage | null>(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.kind === 'problem' && m.chosenOptionId === null) return m
    }
    return null
  })

  /* ---------- 事件订阅 ---------- */
  let offMessage: (() => void) | null = null
  let offMessageUpdated: (() => void) | null = null

  /* ---------- actions ---------- */
  /**
   * 打开工作台对话区。initialMessages 来自 session store 的快照，
   * 由 session.open 内部调用，UI 不需要直接调。
   */
  function open(id: string, initialMessages: ChatMessage[]): void {
    close()
    dashboardId.value = id
    messages.value = [...initialMessages]
    offMessage = api.on('message', (p) => {
      if (p.dashboardId !== dashboardId.value) return
      messages.value.push(p.message)
    })
    // 后端就地改了某条消息（选项已选 / 排队标记摘除）：同 id 原位替换。
    // 注意要换成新对象：同一引用 Vue 不会触发子组件重渲染。
    offMessageUpdated = api.on('messageUpdated', (p) => {
      if (p.dashboardId !== dashboardId.value) return
      const i = messages.value.findIndex((m) => m.id === p.message.id)
      if (i >= 0) messages.value[i] = { ...p.message }
    })
  }

  /** 离开工作台：退订并清空 */
  function close(): void {
    offMessage?.()
    offMessage = null
    offMessageUpdated?.()
    offMessageUpdated = null
    dashboardId.value = null
    messages.value = []
    sending.value = false
  }

  /** 发送消息（生成中也可发，自动排队；attachments 仅多模态模式可用；允许只发图不打字） */
  async function send(text: string, attachmentUrls: string[] = []): Promise<void> {
    if (!dashboardId.value || (!text.trim() && attachmentUrls.length === 0)) return
    sending.value = true
    try {
      await api.sendMessage(dashboardId.value, text.trim(), attachmentUrls)
    } finally {
      sending.value = false
    }
  }

  /** 回答澄清卡片（点选项或自定义输入，一次答完卡片上所有问题） */
  async function answerClarification(messageId: string, answers: ClarificationAnswer[]): Promise<void> {
    if (!dashboardId.value) return
    await api.answerClarification(dashboardId.value, messageId, answers)
    // 乐观更新：stub 不发事件时 UI 也能立即反馈
    const m = messages.value.find((x) => x.id === messageId)
    if (m?.kind === 'clarification') {
      for (const a of answers) {
        const q = m.questions.find((qq) => qq.id === a.questionId)
        if (q) {
          const opt = q.options.find((o) => o.id === a.optionId)
          q.answer = a.customText || opt?.title || ''
        }
      }
      m.answered = true
    }
  }

  /**
   * 选择选项（问题处理卡片 / 右栏卡点行动区共用此入口，两处点击等效）。
   * 点选后卡片折叠，流程立即继续。
   */
  async function chooseOption(optionId: string): Promise<void> {
    if (!dashboardId.value) return
    await api.chooseOption(dashboardId.value, optionId)
    // 乐观更新：把包含该选项的未决问题卡片标记为已选
    const p = activeProblem.value
    if (p && p.options.some((o) => o.id === optionId)) {
      p.chosenOptionId = optionId
    }
  }

  /** 「先等等」：中断低风险推荐的倒计时自动执行（卡片保持展开等用户决定） */
  async function cancelAutoExec(): Promise<void> {
    if (!dashboardId.value) return
    await api.cancelAutoExec(dashboardId.value)
  }

  return {
    dashboardId, messages, sending,
    latestClarification, activeProblem,
    open, close, send, answerClarification, chooseOption, cancelAutoExec
  }
})
