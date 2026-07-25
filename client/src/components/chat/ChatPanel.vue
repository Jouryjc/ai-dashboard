<script setup lang="ts">
/**
 * 左栏对话区（UX §4.2）：消息流 + 时间分组 + 自动滚到底 + 空态引导 + 输入区。
 *
 *  - 五种消息按 kind 渲染（见 MessageItem.vue）；
 *  - 卡片事件在这里接 store：answerClarification / chooseOption；
 *  - 生成中输入框不锁定，发送后上方出现"已收到，将在当前步骤后处理"提示条；
 *  - 空态：欢迎语 + 3 个示例话术 chips（点击即填入输入框）；
 *  - 每条消息外层带 id="chat-msg-<消息ID>"，供右栏"去回答"等入口
 *    用 document.getElementById(...).scrollIntoView() 滚动定位。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useSessionStore } from '../../stores/session'
import type { ChatMessage, ClarificationAnswer } from '../../types'
import MessageItem from './MessageItem.vue'
import ChatInput from './ChatInput.vue'
import AppIcon from '../common/AppIcon.vue'
import { formatDivider, needDivider } from './time'

const chat = useChatStore()
const session = useSessionStore()

/* ---------- 输入框草稿（示例话术 chips 点击填入） ---------- */
const draft = ref('')

/* ---------- 空态引导 ---------- */
const isEmpty = computed(() => chat.messages.length === 0)

const EXAMPLES = [
  '帮我做一个服务器监控大屏',
  '做一个门店销售大屏，要有地图和趋势图',
  '把生产线的实时数据做成大屏，给车间看'
]

function useExample(text: string): void {
  draft.value = text
}

/* ---------- 时间分组：相邻消息间隔 > 5 分钟（或跨天）插入分隔条 ---------- */
interface Row {
  message: ChatMessage
  divider: string | null
}

const rows = computed<Row[]>(() => {
  const list = chat.messages
  return list.map((m, i) => ({
    message: m,
    divider: needDivider(i === 0 ? null : list[i - 1].createdAt, m.createdAt)
      ? formatDivider(m.createdAt)
      : null
  }))
})

/* ---------- 排队提示条：仍在生成中，且还有没处理到的排队消息就一直显示 ---------- */
const queueHint = computed(() => {
  if (session.runStatus !== 'generating') return false
  return chat.messages.some((m) => m.kind === 'user' && m.queued)
})

/* ---------- 自动滚到底：用户没往上翻时跟随新消息；自己发的消息强制跟随 ---------- */
const scroller = ref<HTMLElement | null>(null)
let stickToBottom = true

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  stickToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => chat.messages.length,
  (len) => {
    const last = chat.messages[len - 1]
    // 自己发的消息永远滚到底；其余情况跟随用户浏览位置（没往上翻才滚）
    if (last?.kind === 'user' || stickToBottom) void scrollToBottom()
  },
  { flush: 'post' }
)

watch(isEmpty, (empty) => {
  if (!empty) void scrollToBottom()
})

/* ---------- 卡片事件 → store（CONTRACT §6：卡片不直接碰 store，在这里接线） ---------- */
async function onAnswer(messageId: string, answers: ClarificationAnswer[]): Promise<void> {
  await chat.answerClarification(messageId, answers)
}

async function onChoose(optionId: string): Promise<void> {
  await chat.chooseOption(optionId)
}

/** 问题处理卡片底部自由输入：视为第 4 种选项，直接作为消息发送 */
async function onCustom(text: string): Promise<void> {
  await chat.send(text)
}

/** 问题处理卡片「先等等」：取消倒计时自动执行 */
async function onHold(): Promise<void> {
  await chat.cancelAutoExec()
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-panel">
    <!-- 消息流 -->
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto px-3 py-3 [scrollbar-width:thin]"
      @scroll="onScroll"
    >
      <!-- 空态引导 -->
      <div v-if="isEmpty" class="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-card bg-primary-soft text-primary">
          <AppIcon name="monitoring" :size="24" />
        </div>
        <p class="text-sm font-medium text-ink">告诉我你想要什么样的大屏</p>
        <p class="text-xs leading-relaxed text-ink-secondary">
          用大白话描述就行，比如要监控什么、给谁看，我来一步步帮你做好
        </p>
        <div class="mt-1 flex w-full flex-col gap-2">
          <button
            v-for="ex in EXAMPLES"
            :key="ex"
            type="button"
            class="rounded-card border border-line bg-card px-3 py-2 text-left text-xs text-ink-secondary shadow-card transition-shadow hover:border-primary-border hover:text-primary hover:shadow-card-hover"
            @click="useExample(ex)"
          >
            {{ ex }}
          </button>
        </div>
      </div>

      <!-- 消息列表（外层 id 供右栏"去回答"滚动定位） -->
      <div v-else class="flex flex-col gap-2.5">
        <template v-for="row in rows" :key="row.message.id">
          <div v-if="row.divider" class="my-1 text-center text-xs text-ink-faint">
            {{ row.divider }}
          </div>
          <div :id="`chat-msg-${row.message.id}`">
            <MessageItem
              :message="row.message"
              @answer="onAnswer"
              @choose="onChoose"
              @custom="onCustom"
              @hold="onHold"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- 输入区（永不锁定，生成中自动排队） -->
    <ChatInput v-model="draft" :queue-hint="queueHint" />
  </div>
</template>
