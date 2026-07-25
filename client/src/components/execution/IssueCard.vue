<!--
  Issue 卡片（UX §4.2 右栏）：问题一句话 + "第 N 次尝试" + 状态。
  已修好可展开「查看修复细节」：大白话结论 + 修复前后对比（同图左右滑块对比，拖动分隔线）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Issue } from '../../types'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{ issue: Issue }>()

const expanded = ref(false)

const statusMeta = computed(() => {
  switch (props.issue.status) {
    case 'fixing':
      return { text: '正在修复', textCls: 'text-status-generating', dotCls: 'bg-status-generating animate-pulse-blue' }
    case 'fixed':
      return { text: '已修好', textCls: 'text-status-done', dotCls: 'bg-status-done' }
    case 'failed':
      return { text: '没修好', textCls: 'text-status-attention', dotCls: 'bg-status-attention' }
  }
})

/* ---------- 修复前后对比：左右滑块（同图拖动分隔线，UX §4.2 右栏） ---------- */
/** 分隔线位置（百分比，0=全是修复后，100=全是修复前） */
const pos = ref(50)
const compareRef = ref<HTMLElement | null>(null)
let dragging = false

function posFromEvent(e: PointerEvent): void {
  const el = compareRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  pos.value = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
}

function onCompareDown(e: PointerEvent): void {
  dragging = true
  compareRef.value?.setPointerCapture(e.pointerId)
  posFromEvent(e)
}

function onCompareMove(e: PointerEvent): void {
  if (dragging) posFromEvent(e)
}

function onCompareUp(): void {
  dragging = false
}

/** 上层（修复前）按分隔线位置裁剪 */
const beforeClip = computed(() => `inset(0 ${100 - pos.value}% 0 0)`)
</script>

<template>
  <div class="rounded-control border border-line bg-card p-2.5 shadow-card">
    <div class="flex items-center gap-2">
      <span class="h-2 w-2 shrink-0 rounded-full" :class="statusMeta.dotCls" />
      <p class="min-w-0 flex-1 truncate text-sm text-ink">{{ issue.title }}</p>
      <span class="shrink-0 text-xs" :class="statusMeta.textCls">{{ statusMeta.text }}</span>
    </div>
    <p class="mt-1 pl-4 text-xs text-ink-faint">
      第 {{ issue.attempt }} 次尝试<template v-if="issue.status === 'fixing'">中…</template>
    </p>

    <!-- 修好后可看细节 -->
    <button
      v-if="issue.status === 'fixed'"
      type="button"
      class="mt-1.5 flex items-center gap-1 pl-4 text-xs text-primary hover:text-primary-hover"
      @click="expanded = !expanded"
    >
      <AppIcon
        name="chevron-right"
        :size="14"
        class="transition-transform"
        :class="expanded ? 'rotate-90' : ''"
      />
      {{ expanded ? '收起修复细节' : '查看修复细节' }}
    </button>

    <div v-if="issue.status === 'fixed' && expanded" class="mt-2 border-t border-line pt-2">
      <p class="text-xs leading-5 text-ink-secondary">{{ issue.detail || '问题已修好，大屏显示恢复正常。' }}</p>
      <!-- 修复前后对比：同图左右滑块，按住分隔线拖动 -->
      <div
        ref="compareRef"
        class="relative mt-2 aspect-video w-full cursor-ew-resize touch-none select-none overflow-hidden rounded-control border border-line"
        role="slider"
        aria-label="拖动对比修复前后"
        :aria-valuenow="Math.round(pos)"
        aria-valuemin="0"
        aria-valuemax="100"
        @pointerdown="onCompareDown"
        @pointermove="onCompareMove"
        @pointerup="onCompareUp"
        @pointercancel="onCompareUp"
      >
        <!-- 修复后（底层，完整显示） -->
        <img
          v-if="issue.afterShotUrl"
          :src="issue.afterShotUrl"
          alt="修复后"
          class="absolute inset-0 h-full w-full object-cover"
          draggable="false"
        />
        <div v-else class="absolute inset-0 flex items-center justify-center bg-panel text-xs text-ink-faint">
          修复后截图
        </div>
        <!-- 修复前（上层，按滑块位置裁剪） -->
        <div class="absolute inset-0" :style="{ clipPath: beforeClip }">
          <img
            v-if="issue.beforeShotUrl"
            :src="issue.beforeShotUrl"
            alt="修复前"
            class="absolute inset-0 h-full w-full object-cover"
            draggable="false"
          />
          <div v-else class="absolute inset-0 flex items-center justify-center bg-panel text-xs text-ink-faint">
            修复前截图
          </div>
        </div>
        <!-- 角标 -->
        <span class="absolute left-1.5 top-1.5 z-10 rounded-control bg-ink/60 px-1.5 py-0.5 text-[10px] leading-none text-white">修复前</span>
        <span class="absolute right-1.5 top-1.5 z-10 rounded-control bg-ink/60 px-1.5 py-0.5 text-[10px] leading-none text-white">修复后</span>
        <!-- 分隔线 + 把手 -->
        <div class="absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-card shadow-card" :style="{ left: `${pos}%` }">
          <span
            class="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card text-ink-secondary shadow-pop"
            aria-hidden="true"
          ><AppIcon name="compare-arrows" :size="12" /></span>
        </div>
      </div>
      <p class="mt-1 text-center text-xs text-ink-faint">按住左右拖动，对比修复前后</p>
    </div>
  </div>
</template>
