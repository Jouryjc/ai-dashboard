<script setup lang="ts">
/**
 * 整行选项按钮 —— 澄清卡片 / 问题处理卡片 / 右栏卡点行动区共用。
 * 规范（UX §4.3）：推荐项 ★推荐 高亮描边 + 推荐理由小字；每项一句"选了会发生什么"。
 * 只接收 props + emit，不接 store（CONTRACT §6）。
 */
import type { CardOption } from '../../types'
import AppIcon from '../common/AppIcon.vue'

defineProps<{
  /** 选项数据（标题 / 后果说明 / 是否推荐 / 推荐理由） */
  option: CardOption
  /** 已答完/已选后整卡禁用 */
  disabled?: boolean
  /** 本地已选中的那一项（答完前给用户即时反馈） */
  selected?: boolean
}>()

const emit = defineEmits<{
  /** 点选即生效，调用方接 chat.chooseOption / 记录澄清答案 */
  (e: 'select', optionId: string): void
}>()
</script>

<template>
  <button
    type="button"
    class="w-full rounded-card border px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    :class="[
      option.recommended
        ? 'border-primary bg-primary-soft/50 hover:bg-primary-soft'
        : 'border-line bg-card hover:border-primary-border hover:bg-primary-soft/40',
      selected ? 'border-primary bg-primary-soft' : ''
    ]"
    :disabled="disabled"
    @click="emit('select', option.id)"
  >
    <span class="flex items-center gap-2">
      <span
        v-if="option.recommended"
        class="inline-flex shrink-0 items-center gap-0.5 rounded-control bg-primary px-1.5 py-0.5 text-[11px] font-medium leading-none text-white"
      ><AppIcon name="star" :size="11" /> 推荐</span>
      <span class="text-sm font-medium text-ink">{{ option.title }}</span>
    </span>
    <span
      v-if="option.recommended && option.recommendReason"
      class="mt-1 block text-xs text-primary"
    >{{ option.recommendReason }}</span>
    <span
      v-if="option.consequence"
      class="mt-0.5 block text-xs leading-relaxed text-ink-secondary"
    >{{ option.consequence }}</span>
  </button>
</template>
