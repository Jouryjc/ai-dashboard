<script setup lang="ts">
/**
 * 首页左侧导航栏（视觉还原 stitch-reference/home-a.html）。
 * 当前只有「主页」是真实可用的；其余入口尚未开通，置灰展示。
 */
import AppIcon from '../common/AppIcon.vue'
</script>

<template>
  <aside
    class="fixed left-0 top-16 bottom-0 w-[260px] z-40 flex flex-col p-4 bg-panel border-r border-line"
  >
    <div class="mb-8 px-2">
      <h2 class="text-ink font-bold text-lg">工作台</h2>
      <p class="text-ink-secondary text-xs flex items-center gap-1.5 mt-0.5">
        v1.0
        <span class="w-1.5 h-1.5 bg-status-done rounded-full"></span>
        运行正常
      </p>
    </div>

    <nav class="flex-1 space-y-1">
      <a
        class="flex items-center gap-3 px-4 py-3 bg-primary-soft text-primary rounded-card font-bold cursor-default select-none"
      >
        <AppIcon name="home" :size="18" />
        <span>主页</span>
      </a>
      <a
        v-for="item in [
          { label: '工作台', icon: 'monitor' },
          { label: '项目', icon: 'folder' },
          { label: '分析', icon: 'monitoring' },
          { label: '协助队列', icon: 'headset-mic' }
        ]"
        :key="item.label"
        class="flex items-center gap-3 px-4 py-3 text-ink-faint rounded-card cursor-not-allowed select-none"
        :title="`${item.label}（即将上线）`"
      >
        <AppIcon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </a>
    </nav>

    <div class="pt-4 border-t border-line mt-auto">
      <a
        class="flex items-center gap-3 px-4 py-3 text-ink-faint rounded-card cursor-not-allowed select-none"
        title="帮助（即将上线）"
      >
        <AppIcon name="help" :size="18" />
        <span>帮助</span>
      </a>
    </div>
  </aside>
</template>
