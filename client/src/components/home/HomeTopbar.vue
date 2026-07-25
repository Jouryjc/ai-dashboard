<script setup lang="ts">
/**
 * 首页顶栏：☰ 菜单 + 产品名、搜索框、设置入口（跳 /settings）、头像。
 * 视觉基准：stitch-reference/home-a.html 顶部导航。
 */
import { useRouter } from 'vue-router'
import AppIcon from '../common/AppIcon.vue'

defineProps<{ keyword: string }>()
const emit = defineEmits<{
  'update:keyword': [value: string]
  'toggle-sidebar': []
}>()

const router = useRouter()

function onInput(e: Event): void {
  emit('update:keyword', (e.target as HTMLInputElement).value)
}

function goSettings(): void {
  router.push('/settings')
}
</script>

<template>
  <header
    class="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-4 h-16 bg-card border-b border-line"
  >
    <div class="flex items-center gap-2">
      <button
        class="p-2 rounded-full hover:bg-panel transition-colors active:opacity-80 text-ink-secondary"
        title="收起 / 展开侧栏"
        @click="emit('toggle-sidebar')"
      >
        <AppIcon name="menu" :size="22" />
      </button>
      <span class="text-lg font-bold text-primary select-none">AI 大屏工作台</span>
    </div>

    <div class="flex items-center gap-4">
      <div class="relative hidden md:block">
        <AppIcon
          name="search"
          :size="18"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none"
        />
        <input
          :value="keyword"
          class="bg-panel border-none rounded-full py-2 pl-10 pr-4 w-64 text-sm text-ink placeholder:text-ink-faint focus:ring-2 focus:ring-primary focus:bg-card transition-all outline-none"
          placeholder="搜索大屏"
          type="text"
          @input="onInput"
        />
      </div>

      <div class="flex items-center gap-2">
        <button
          class="p-2 rounded-full hover:bg-panel transition-colors active:opacity-80 text-ink-secondary"
          title="设置"
          @click="goSettings"
        >
          <AppIcon name="settings" :size="22" />
        </button>
        <div
          class="h-8 w-8 rounded-full bg-primary-soft text-primary flex items-center justify-center text-sm font-bold border border-primary-border select-none"
          title="我的账号"
        >
          我
        </div>
      </div>
    </div>
  </header>
</template>
