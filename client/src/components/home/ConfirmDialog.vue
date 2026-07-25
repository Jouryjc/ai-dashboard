<script setup lang="ts">
/**
 * 删除大屏前的二次确认弹层（大白话，红色危险按钮）。
 */
import { onMounted, onUnmounted } from 'vue'
import type { Dashboard } from '../../types'

defineProps<{ dashboard: Dashboard; busy: boolean }>()
const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('cancel')
  if (e.key === 'Enter') emit('confirm')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="fixed inset-0 z-[110] bg-ink/40 backdrop-blur-sm flex items-center justify-center p-6"
    @click="emit('cancel')"
  >
    <div
      class="bg-card rounded-card shadow-pop w-full max-w-sm p-6"
      role="dialog"
      aria-modal="true"
      @click.stop
    >
      <h3 class="text-lg font-bold text-ink mb-2">删除这个大屏？</h3>
      <p class="text-sm text-ink-secondary leading-relaxed">
        「{{ dashboard.name }}」删除后就找不回来了。确定要删除吗？
      </p>
      <div class="flex justify-end gap-3 mt-6">
        <button
          class="px-4 py-2 rounded-control text-sm font-medium text-ink-secondary hover:bg-panel transition-colors"
          :disabled="busy"
          @click="emit('cancel')"
        >
          先留着
        </button>
        <button
          class="px-4 py-2 rounded-control text-sm font-medium bg-danger text-white hover:opacity-90 transition-opacity disabled:opacity-60"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '正在删除…' : '确定删除' }}
        </button>
      </div>
    </div>
  </div>
</template>
