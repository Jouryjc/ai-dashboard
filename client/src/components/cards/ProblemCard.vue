<script setup lang="ts">
/**
 * 问题处理卡片（UX §4.3，规范强制逐条落实）：
 *  1. 一句话说清发生了什么 + 影响（title + description）
 *  2. 1~3 个整行选项按钮，恰好一个 ★推荐 + 推荐理由（OptionButton 负责渲染）
 *  3. 每个选项下方一句"选了会发生什么/代价"（option.consequence）
 *  4. 底部"也可以直接输入你的想法…"输入框兜底（打字 = 第 4 种选项）
 *  5. 点选即继续，卡片折叠为一行系统条（"你选择了：xxx"），不需要再点发送
 *  7. 低风险推荐带倒计时圆环（纯展示）；到点的自动执行由引擎统一触发（唯一触发源，
 *     系统条文案确定为"已自动执行推荐方案"）；「先等等」emit('hold') 通知引擎取消；
 *     回退/发布/权限类（autoExecuteAt 为 null）永不自动执行
 *
 * 使用方（chat agent / exec-panel agent）接事件后调 chat.chooseOption(optionId)；
 * 自定义输入接 'custom' 事件后调 chat.send(text)。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CardOption, ProblemMessage } from '../../types'
import OptionButton from './OptionButton.vue'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{
  /** 问题处理卡片消息（kind: 'problem'） */
  message: ProblemMessage
}>()

const emit = defineEmits<{
  /** 点选某个选项 */
  (e: 'choose', optionId: string): void
  /** 底部自由输入提交（视为第 4 种选项） */
  (e: 'custom', text: string): void
  /** 「先等等」：通知引擎取消倒计时自动执行，卡片保持展开 */
  (e: 'hold'): void
}>()

/* ---------- 已选择：折叠为系统条 ---------- */
const chosen = computed(() => props.message.chosenOptionId)
const chosenTitle = computed(
  () => props.message.options.find(o => o.id === chosen.value)?.title
    ?? (chosen.value === 'free-text' ? '按自己的想法再试一次' : '')
)

/* ---------- 倒计时自动执行（纯展示：引擎的自动执行定时器是唯一触发源） ---------- */
const autoOption = computed<CardOption | null>(() => {
  if (chosen.value) return null
  const rec = props.message.options.find(o => o.recommended)
  if (rec && rec.riskLevel === 'low' && rec.autoExecuteAt && rec.autoExecuteAt > Date.now()) {
    return rec
  }
  return null
})

const totalMs = ref(0)
const remainMs = ref(0)
/** 用户点了「先等等」后不再显示倒计时 */
const cancelled = ref(false)
let timer: number | undefined

function stopTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

function startCountdown(): void {
  stopTimer()
  const opt = autoOption.value
  if (!opt || cancelled.value || !opt.autoExecuteAt) return
  totalMs.value = opt.autoExecuteAt - Date.now()
  remainMs.value = totalMs.value
  timer = window.setInterval(() => {
    if (!opt.autoExecuteAt) return
    remainMs.value = opt.autoExecuteAt - Date.now()
    if (remainMs.value <= 0) {
      // 到点只停表，不在这里 emit：引擎到点会自动执行并推回结果（单一触发源）
      stopTimer()
    }
  }, 100)
}

/** 「先等等」：通知引擎取消自动执行，卡片保持展开等用户决定 */
function holdOn(): void {
  cancelled.value = true
  stopTimer()
  emit('hold')
}

watch(autoOption, v => { if (v) startCountdown() }, { immediate: true })
onBeforeUnmount(stopTimer)

const remainSec = computed(() => Math.max(0, Math.ceil(remainMs.value / 1000)))
const showCountdown = computed(() => !!autoOption.value && !cancelled.value)

/* 倒计时圆环（SVG，描边色走 tokens.css 暴露的 CSS 变量，不写死色值） */
const RING_R = 9
const RING_CIRC = 2 * Math.PI * RING_R
const ringOffset = computed(() => {
  const frac = totalMs.value > 0 ? Math.max(0, remainMs.value / totalMs.value) : 0
  return RING_CIRC * (1 - frac)
})

/* ---------- 交互 ---------- */
const customText = ref('')

function choose(optionId: string): void {
  if (chosen.value) return
  stopTimer()
  emit('choose', optionId)
}

function submitCustom(): void {
  const text = customText.value.trim()
  if (!text || chosen.value) return
  stopTimer()
  emit('custom', text)
  customText.value = ''
}
</script>

<template>
  <!-- 已选择：折叠为一行系统条 -->
  <div
    v-if="chosen"
    class="flex items-center gap-2 rounded-card border border-line bg-panel px-3 py-2 text-xs text-ink-secondary"
  >
    <AppIcon name="check-circle" :size="14" class="shrink-0 text-status-done" />
    <span class="truncate">你选择了：{{ chosenTitle }}</span>
  </div>

  <!-- 未选择：完整卡片 -->
  <div v-else class="rounded-card border border-line bg-card p-4 shadow-card">
    <!-- 一句话说清发生了什么 + 影响 -->
    <div class="mb-3 flex items-start gap-2">
      <span
        class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status-attention-soft text-status-attention"
      ><AppIcon name="warning" :size="14" /></span>
      <div>
        <p class="text-sm font-medium text-ink">{{ message.title }}</p>
        <p class="mt-0.5 text-xs leading-relaxed text-ink-secondary">{{ message.description }}</p>
      </div>
    </div>

    <!-- 选项列表（1~3 个，恰好一个 ★推荐） -->
    <div class="flex flex-col gap-2">
      <OptionButton
        v-for="opt in message.options"
        :key="opt.id"
        :option="opt"
        @select="choose"
      />
    </div>

    <!-- 低风险推荐：倒计时圆环自动执行，可随时中断 -->
    <div
      v-if="showCountdown"
      class="mt-3 flex items-center gap-2 rounded-control bg-panel px-2.5 py-1.5 text-xs text-ink-secondary"
    >
      <svg width="22" height="22" viewBox="0 0 22 22" class="shrink-0 -rotate-90">
        <circle cx="11" cy="11" :r="RING_R" fill="none" stroke="var(--color-line-strong)" stroke-width="2.5" />
        <circle
          cx="11" cy="11" :r="RING_R" fill="none"
          stroke="var(--brand-primary)" stroke-width="2.5" stroke-linecap="round"
          :stroke-dasharray="RING_CIRC"
          :stroke-dashoffset="ringOffset"
        />
      </svg>
      <span class="flex-1">{{ remainSec }} 秒后不选择将自动执行推荐方案</span>
      <button
        type="button"
        class="shrink-0 rounded-control px-1.5 py-0.5 text-xs text-primary hover:bg-primary-soft"
        @click="holdOn"
      >先等等</button>
    </div>

    <!-- 自由输入兜底（第 4 种选项） -->
    <div class="mt-3 flex items-center gap-2 border-t border-line pt-3">
      <input
        v-model="customText"
        type="text"
        class="h-8 flex-1 rounded-control border border-line bg-card px-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
        placeholder="也可以直接输入你的想法…"
        @keyup.enter="submitCustom"
      />
      <button
        type="button"
        class="h-8 shrink-0 rounded-control bg-primary px-3 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        :disabled="!customText.trim()"
        @click="submitCustom"
      >发送</button>
    </div>
  </div>
</template>
