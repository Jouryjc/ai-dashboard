<script setup lang="ts">
/**
 * 设置中心占位页（数据源 / 通知等尚未开放的板块）。
 * 简洁「即将上线」风格，导航结构先到位。
 */
import AppIcon from '../common/AppIcon.vue'

defineProps<{
  /** 板块图标（AppIcon 注册名） */
  icon: string
  /** 板块名，如 "数据源" */
  title: string
  /** 一句话说明这个板块将来能干什么（大白话） */
  description: string
}>()
</script>

<template>
  <section
    class="flex min-h-72 flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-card p-10 text-center shadow-card"
  >
    <AppIcon :name="icon" :size="40" class="text-ink-faint" />
    <h2 class="mt-4 text-base font-semibold text-ink">{{ title }}</h2>
    <span
      class="mt-2 rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary"
    >即将上线</span>
    <p class="mt-3 max-w-sm text-sm text-ink-secondary">{{ description }}</p>
  </section>
</template>
