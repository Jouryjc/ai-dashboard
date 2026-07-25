<script setup lang="ts">
/**
 * 双击封面后的全屏预览 overlay。
 * 首页拿不到大屏实时画面，这里把最近一次构建的封面截图放大展示；
 * 点击空白处 / 按 Esc 关闭，也可以直接「进入工作台」继续编辑。
 */
import { onMounted, onUnmounted } from 'vue'
import type { Dashboard } from '../../types'
import StatusBadge from './StatusBadge.vue'
import AppIcon from '../common/AppIcon.vue'

defineProps<{ dashboard: Dashboard }>()
const emit = defineEmits<{
  close: []
  open: [dashboard: Dashboard]
}>()

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="fixed inset-0 z-[100] bg-ink/80 backdrop-blur-sm flex flex-col"
    @click="emit('close')"
  >
    <!-- 顶部：名称 + 徽标 + 关闭 -->
    <div class="flex items-center justify-between px-6 h-16 shrink-0" @click.stop>
      <div class="flex items-center gap-3 min-w-0">
        <h2 class="text-white font-bold text-lg truncate">{{ dashboard.name }}</h2>
        <StatusBadge :status="dashboard.status" />
      </div>
      <div class="flex items-center gap-3">
        <button
          class="px-4 py-2 rounded-control bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          @click="emit('open', dashboard)"
        >
          进入工作台继续编辑
        </button>
        <button
          class="p-2 rounded-full text-white/80 hover:bg-white/10 transition-colors"
          title="关闭"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="22" />
        </button>
      </div>
    </div>

    <!-- 中部：放大封面 -->
    <div class="flex-1 flex items-center justify-center px-8 pb-4 min-h-0" @click="emit('close')">
      <img
        v-if="dashboard.coverUrl"
        class="max-w-full max-h-full object-contain rounded-card shadow-pop"
        :src="dashboard.coverUrl"
        :alt="dashboard.name"
        @click.stop
      />
      <div
        v-else
        class="w-[960px] max-w-full aspect-video bg-panel rounded-card flex flex-col items-center justify-center text-ink-faint gap-3"
        @click.stop
      >
        <AppIcon name="monitor" :size="56" />
        <p class="text-sm">这个大屏还没有画面，进入工作台说句话就开始生成</p>
      </div>
    </div>

    <!-- 底部提示 -->
    <div class="shrink-0 pb-5 text-center text-white/60 text-xs select-none">
      这是最近一次生成的样子 · 点击空白处或按 Esc 关闭
    </div>
  </div>
</template>
