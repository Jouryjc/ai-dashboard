<script setup lang="ts">
/**
 * 澄清卡片（UX §4.2）：一次最多 3 个问题；选项为整行按钮；明显更优答案带 ★推荐；
 * 支持自定义输入兜底；回答后立即 emit，无需再点发送；答完折叠为一行系统条（"已选择：xxx"）。
 * 使用方（chat agent）接事件后调 chat.answerClarification(messageId, answers)。
 */
import { computed, reactive } from 'vue'
import type {
  ClarificationAnswer,
  ClarificationMessage,
  ClarificationQuestion
} from '../../types'
import OptionButton from './OptionButton.vue'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{
  /** 澄清卡片消息（kind: 'clarification'） */
  message: ClarificationMessage
}>()

const emit = defineEmits<{
  /** 全部问题答完时触发一次（点选即继续，无需再点发送）；messageId 由使用方从 message prop 自取 */
  (e: 'answer', answers: ClarificationAnswer[]): void
}>()

/** 一次最多 3 个问题（UX §4.2 硬性上限） */
const MAX_QUESTIONS = 3
const questions = computed(() => props.message.questions.slice(0, MAX_QUESTIONS))

/** 本地即时记录每题答案（optionId 为空串 = 自定义输入） */
const localAnswers = reactive<Record<string, { optionId: string; label: string; customText: string }>>({})
/** 每题的自定义输入草稿 */
const customDrafts = reactive<Record<string, string>>({})

function pick(q: ClarificationQuestion, optionId: string): void {
  if (props.message.answered || localAnswers[q.id]) return
  const opt = q.options.find(o => o.id === optionId)
  localAnswers[q.id] = { optionId, label: opt?.title ?? '', customText: '' }
  maybeSubmit()
}

function submitCustom(q: ClarificationQuestion): void {
  const text = (customDrafts[q.id] ?? '').trim()
  if (!text || props.message.answered || localAnswers[q.id]) return
  localAnswers[q.id] = { optionId: '', label: text, customText: text }
  maybeSubmit()
}

/** 所有问题都有答案后立即整体 emit，流程自动继续 */
function maybeSubmit(): void {
  if (!questions.value.every(q => localAnswers[q.id])) return
  emit(
    'answer',
    questions.value.map(q => ({
      questionId: q.id,
      optionId: localAnswers[q.id].optionId,
      customText: localAnswers[q.id].customText
    }))
  )
}

/** 答完折叠为一行系统条："已选择：xxx、yyy" */
const summaryText = computed(() =>
  questions.value
    .map(q => q.answer ?? localAnswers[q.id]?.label ?? '')
    .filter(Boolean)
    .join('、')
)
</script>

<template>
  <!-- 已答完：折叠为一行系统条 -->
  <div
    v-if="message.answered"
    class="flex items-center gap-2 rounded-card border border-line bg-panel px-3 py-2 text-xs text-ink-secondary"
  >
    <AppIcon name="check-circle" :size="14" class="shrink-0 text-status-done" />
    <span class="truncate">已选择：{{ summaryText }}</span>
  </div>

  <!-- 未答完：完整卡片 -->
  <div v-else class="rounded-card border border-line bg-card p-4 shadow-card">
    <div class="mb-3 flex items-center gap-2">
      <AppIcon name="chat-bubble" :size="16" class="shrink-0 text-primary" />
      <p class="text-sm font-medium text-ink">{{ message.intro }}</p>
    </div>

    <div
      v-for="(q, qi) in questions"
      :key="q.id"
      class="border-t border-line pt-3"
      :class="qi > 0 ? 'mt-3' : ''"
    >
      <p class="mb-2 text-sm text-ink">
        <span class="mr-1 text-ink-faint">{{ qi + 1 }}.</span>{{ q.question }}
      </p>

      <div class="flex flex-col gap-2">
        <OptionButton
          v-for="opt in q.options"
          :key="opt.id"
          :option="opt"
          :disabled="!!localAnswers[q.id]"
          :selected="localAnswers[q.id]?.optionId === opt.id"
          @select="pick(q, $event)"
        />
      </div>

      <!-- 自定义输入兜底 -->
      <div v-if="q.allowCustomInput" class="mt-2 flex items-center gap-2">
        <input
          v-model="customDrafts[q.id]"
          type="text"
          class="h-8 flex-1 rounded-control border border-line bg-card px-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none disabled:opacity-60"
          placeholder="也可以自己输入…"
          :disabled="!!localAnswers[q.id]"
          @keyup.enter="submitCustom(q)"
        />
        <button
          type="button"
          class="h-8 shrink-0 rounded-control bg-primary px-3 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
          :disabled="!!localAnswers[q.id] || !(customDrafts[q.id] ?? '').trim()"
          @click="submitCustom(q)"
        >确定</button>
      </div>
    </div>
  </div>
</template>
