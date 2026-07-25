<!--
  人工协助卡（UX §5.5）：🎧 "支持人员 xx 正在协助你" + 代办动作实时流水 + [结束协助]。
  结束协助带一次轻确认，防止误点。
-->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { AssistSession } from '../../types'
import { formatClock } from './utils'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{ assist: AssistSession }>()
const emit = defineEmits<{ end: [] }>()

const confirming = ref(false)

/* 新动作进来时流水自动滚到底 */
const listEl = ref<HTMLElement | null>(null)
watch(
  () => props.assist.actions.length,
  async () => {
    await nextTick()
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
  }
)
</script>

<template>
  <section class="rounded-card border border-primary-border bg-primary-soft p-3" aria-label="人工协助中">
    <div class="flex items-center gap-2">
      <AppIcon name="headset-mic" :size="18" class="shrink-0 text-primary" />
      <p class="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        支持人员 {{ assist.operatorName }} 正在协助你
      </p>
      <span class="h-2 w-2 shrink-0 rounded-full bg-status-generating animate-pulse-blue" />
    </div>

    <!-- 代办动作实时流水（透明原则：客服每个动作都推给你看） -->
    <div ref="listEl" class="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
      <p v-for="(a, i) in assist.actions" :key="i" class="text-xs leading-5 text-ink-secondary">
        <span class="mr-1.5 text-ink-faint">{{ formatClock(a.at) }}</span>{{ a.text }}
      </p>
      <p v-if="!assist.actions.length" class="text-xs text-ink-faint">正在接入，请稍等…</p>
    </div>

    <!-- 结束协助（随时可收回控制权） -->
    <div class="mt-2.5">
      <div v-if="confirming" class="flex items-center gap-2">
        <p class="flex-1 text-xs text-ink-secondary">确定结束协助？之后你可以继续自己操作。</p>
        <button
          type="button"
          class="rounded-control bg-danger px-2.5 py-1 text-xs text-white hover:opacity-90"
          @click="emit('end'); confirming = false"
        >结束</button>
        <button
          type="button"
          class="rounded-control border border-line bg-card px-2.5 py-1 text-xs text-ink-secondary hover:bg-panel"
          @click="confirming = false"
        >再等等</button>
      </div>
      <button
        v-else
        type="button"
        class="w-full rounded-control border border-line bg-card px-3 py-1.5 text-sm text-ink-secondary hover:bg-panel"
        @click="confirming = true"
      >结束协助</button>
    </div>
  </section>
</template>
