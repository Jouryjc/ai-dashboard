<script setup lang="ts">
/**
 * 单条消息渲染（五种类型，UX §4.2）：
 *   1. 用户消息：右侧蓝色气泡（排队中的带"已收到，将在当前步骤后处理"小字）
 *   2. Agent 消息：左侧白色卡片气泡（大白话）
 *   3. 澄清卡片 / 4. 问题处理卡片：复用 cards agent 的组件（props 进、事件出）
 *   5. 系统操作条：居中轻量灰条（"已回退到 v2 版本"）
 * 本组件不直接调 store，卡片事件通过 emit 上抛给 ChatPanel 接 store。
 */
import type {
  ChatMessage,
  ClarificationAnswer,
  ClarificationMessage,
  ProblemMessage
} from '../../types'
import { ClarificationCard, ProblemCard } from '../cards'

const props = defineProps<{ message: ChatMessage }>()

const emit = defineEmits<{
  /** 澄清卡片答完所有问题 */
  answer: [messageId: string, answers: ClarificationAnswer[]]
  /** 问题处理卡片点选某个选项 */
  choose: [optionId: string]
  /** 问题处理卡片底部自由输入（视为第 4 种选项，直接作为消息发送） */
  custom: [text: string]
  /** 问题处理卡片「先等等」：取消倒计时自动执行 */
  hold: []
}>()

function onClarificationAnswer(answers: ClarificationAnswer[]): void {
  if (props.message.kind === 'clarification') emit('answer', props.message.id, answers)
}

function onProblemChoose(optionId: string): void {
  emit('choose', optionId)
}

function onProblemCustom(text: string): void {
  emit('custom', text)
}

// 类型收窄辅助（模板里分支渲染用）
function asClarification(m: ChatMessage): ClarificationMessage {
  return m as ClarificationMessage
}
function asProblem(m: ChatMessage): ProblemMessage {
  return m as ProblemMessage
}
</script>

<template>
  <!-- 1. 用户消息：右侧蓝色气泡 -->
  <div v-if="message.kind === 'user'" class="flex flex-col items-end gap-1">
    <div
      v-if="message.attachmentUrls.length > 0"
      class="flex max-w-[85%] flex-wrap justify-end gap-1.5"
    >
      <img
        v-for="(url, i) in message.attachmentUrls"
        :key="i"
        :src="url"
        alt="你发的图片"
        class="h-16 w-16 rounded-control border border-line object-cover"
      />
    </div>
    <div
      class="max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-primary px-3 py-2 text-sm leading-relaxed text-white shadow-card"
    >
      {{ message.text }}
    </div>
    <p v-if="message.queued" class="pr-1 text-xs text-ink-faint">
      已收到，将在当前步骤后处理
    </p>
  </div>

  <!-- 2. Agent 消息：左侧白色卡片气泡 -->
  <div v-else-if="message.kind === 'agent'" class="flex justify-start">
    <div
      class="max-w-[85%] whitespace-pre-wrap break-words rounded-card border border-line bg-card px-3 py-2 text-sm leading-relaxed text-ink shadow-card"
    >
      {{ message.text }}
    </div>
  </div>

  <!-- 3. 澄清卡片（cards agent 组件，props 进 / 事件出） -->
  <ClarificationCard
    v-else-if="message.kind === 'clarification'"
    :message="asClarification(message)"
    @answer="onClarificationAnswer"
  />

  <!-- 4. 问题处理卡片（cards agent 组件；@custom = 底部自由输入兜底；@hold = 先等等） -->
  <ProblemCard
    v-else-if="message.kind === 'problem'"
    :message="asProblem(message)"
    @choose="onProblemChoose"
    @custom="onProblemCustom"
    @hold="emit('hold')"
  />

  <!-- 5. 系统操作条：居中轻量灰条 -->
  <div v-else class="flex justify-center">
    <span class="rounded-full bg-line px-3 py-1 text-xs text-ink-secondary">
      {{ message.text }}
    </span>
  </div>
</template>
