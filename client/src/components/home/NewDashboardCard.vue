<script setup lang="ts">
/**
 * 「＋ 新建大屏」卡片 —— 固定在网格首位。
 * 点击后由父组件调 store.create 并跳转工作台；creating 期间防重复点击。
 */
import AppIcon from '../common/AppIcon.vue'

defineProps<{ creating: boolean }>()
const emit = defineEmits<{ create: [] }>()
</script>

<template>
  <div
    class="group relative h-full min-h-[280px] border-2 border-dashed border-line-strong rounded-card flex flex-col items-center justify-center cursor-pointer hover:border-primary hover:bg-primary-soft/40 transition-all active:scale-95 select-none"
    :class="{ 'opacity-60 pointer-events-none': creating }"
    role="button"
    tabindex="0"
    @click="emit('create')"
    @keydown.enter="emit('create')"
  >
    <div
      class="w-12 h-12 rounded-full bg-panel flex items-center justify-center text-primary mb-3 group-hover:scale-110 transition-transform"
    >
      <AppIcon v-if="!creating" name="add" :size="28" />
      <svg v-else class="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    </div>
    <span class="inline-flex items-center gap-1 text-ink-secondary font-medium group-hover:text-primary transition-colors">
      <AppIcon v-if="!creating" name="add" :size="14" />
      {{ creating ? '正在创建…' : '新建项目' }}
    </span>
  </div>
</template>
