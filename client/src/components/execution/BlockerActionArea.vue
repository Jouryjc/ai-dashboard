<!--
  卡点行动区（UX §5.4）：仅卡点时固定在执行面板顶部，警示橙高亮色。
  按卡点五类渲染：等待澄清 / 外部阻塞 / 修复超预算升级 / 失败 / 停留超时。
  选项与对话区问题处理卡片同一事件源：点击 emit('choose', optionId)，
  由 ExecutionPanel 统一调 chat.chooseOption(optionId)，两处状态天然一致。
  恰好一个 ★推荐 选项高亮 + 推荐理由。等待澄清类显示「去回答」（emit 滚动定位事件）。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Blocker, BlockerType, CardOption } from '../../types'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{ blocker: Blocker }>()
const emit = defineEmits<{
  choose: [optionId: string]
  goAnswer: [messageId: string]
}>()

/** 五类卡点的小图标（UX §5.4 表格），值为 AppIcon 注册名 */
const TYPE_ICON: Record<BlockerType, string> = {
  clarification: 'chat-bubble',
  external: 'cable',
  escalated: 'support-agent',
  failed: 'warning',
  stall: 'hourglass'
}

/* 低风险推荐选项的自动执行倒计时（仅展示，真正自动执行由引擎到点触发） */
const now = ref(Date.now())
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})

function countdownOf(opt: CardOption): string {
  if (!opt.autoExecuteAt) return ''
  const s = Math.max(0, Math.ceil((opt.autoExecuteAt - now.value) / 1000))
  return s > 0 ? `${s} 秒后不选择将自动执行` : ''
}

function goAnswer(): void {
  if (props.blocker.relatedMessageId) emit('goAnswer', props.blocker.relatedMessageId)
}
</script>

<template>
  <section class="rounded-card border border-status-attention bg-status-attention-soft p-3" aria-label="需要你处理">
    <div class="flex items-start gap-2">
      <AppIcon :name="TYPE_ICON[blocker.type]" :size="16" class="mt-0.5 shrink-0 text-status-attention" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-ink">{{ blocker.title }}</p>
        <p class="mt-0.5 text-xs leading-5 text-ink-secondary">{{ blocker.description }}</p>
      </div>
    </div>

    <!-- 等待澄清：去回答（滚动定位到对话区澄清卡片） -->
    <button
      v-if="blocker.type === 'clarification'"
      type="button"
      class="mt-2.5 w-full rounded-control bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover active:bg-primary-active"
      @click="goAnswer"
    >去回答</button>

    <!-- 行动选项（与对话区问题处理卡片同一组，恰好一个 ★推荐）。
         等待澄清类不渲染选项列表：行动区只有「去回答」一个按钮（UX §5.4 表格），
         避免出现两个"去回答"入口且列表里的那个点了没反应 -->
    <div v-if="blocker.type !== 'clarification' && blocker.options.length" class="mt-2.5 flex flex-col gap-2">
      <button
        v-for="opt in blocker.options"
        :key="opt.id"
        type="button"
        class="rounded-control border bg-card px-3 py-2 text-left transition-colors"
        :class="opt.recommended
          ? 'border-primary shadow-card hover:bg-primary-soft'
          : 'border-line hover:border-line-strong hover:bg-panel'"
        @click="emit('choose', opt.id)"
      >
        <span class="flex items-center gap-1.5">
          <span
            v-if="opt.recommended"
            class="inline-flex items-center gap-0.5 rounded-control bg-primary-soft px-1 py-0.5 text-[11px] leading-none text-primary"
          ><AppIcon name="star" :size="11" /> 推荐</span>
          <span class="text-sm font-medium text-ink">{{ opt.title }}</span>
        </span>
        <span class="mt-0.5 block text-xs leading-5 text-ink-secondary">{{ opt.consequence }}</span>
        <span v-if="opt.recommended && opt.recommendReason" class="mt-0.5 block text-xs text-primary">
          {{ opt.recommendReason }}
        </span>
        <span v-if="countdownOf(opt)" class="mt-0.5 block text-xs text-status-attention">
          {{ countdownOf(opt) }}
        </span>
      </button>
    </div>
  </section>
</template>
