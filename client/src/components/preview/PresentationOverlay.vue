<script setup lang="ts">
/**
 * 全屏演示模式（UX §7.4）：纯大屏覆盖全窗口，供投屏汇报。
 * - 按当前预览分辨率等比缩放铺满窗口，隐藏三栏的一切界面元素。
 * - 按 Esc 退出；进入时短暂提示「按 Esc 退出全屏」。
 * 由顶栏 ⛶全屏 打开：url 取自 session.previewUrl。
 */
import { onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import { useSessionStore } from '../../stores/session'
import { useScaleFit } from './useScaleFit'

const emit = defineEmits<{ (e: 'exit'): void }>()

const session = useSessionStore()
const { containerRef, frameStyle } = useScaleFit(toRef(session, 'resolution'))

/* Esc 退出 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('exit')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/* 进入时短暂显示退出提示 */
const showHint = ref(true)
let hintTimer: number | undefined
onMounted(() => {
  hintTimer = window.setTimeout(() => {
    showHint.value = false
  }, 3000)
})
onBeforeUnmount(() => window.clearTimeout(hintTimer))
</script>

<template>
  <div class="fixed inset-0 z-50 bg-ink" role="dialog" aria-label="全屏演示模式">
    <div ref="containerRef" class="flex h-full w-full items-center justify-center overflow-hidden">
      <div v-if="session.previewUrl" :style="frameStyle" class="shrink-0 overflow-hidden bg-ink">
        <iframe
          :src="session.previewUrl"
          :title="session.artifactKind === 'business-app' ? '业务应用全屏预览' : '大屏全屏演示'"
          class="block h-full w-full border-0 bg-ink"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      <p v-else class="text-sm text-white/70">
        还没有可以演示的{{ session.artifactKind === 'business-app' ? '业务应用' : '大屏' }}
      </p>
    </div>

    <Transition name="hint-fade">
      <div
        v-if="showHint"
        class="absolute left-1/2 top-6 -translate-x-1/2 rounded-card bg-white/10 px-4 py-2 text-sm text-white/80"
      >
        按 Esc 退出全屏
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.hint-fade-enter-active,
.hint-fade-leave-active {
  transition: opacity 0.3s ease;
}
.hint-fade-enter-from,
.hint-fade-leave-to {
  opacity: 0;
}
</style>
