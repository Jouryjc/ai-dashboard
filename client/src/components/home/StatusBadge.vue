<script setup lang="ts">
/**
 * 状态徽标 —— 只有四种大白话状态：生成中 / 已完成 / 已发布 / 需要处理。
 * 文案一律查 DASHBOARD_STATUS_LABEL（src/types），不另写映射。
 * 生成中带进行蓝呼吸动画；需要处理为警示橙并带 ⚠。
 */
import { computed } from 'vue'
import type { DashboardStatus } from '../../types'
import { DASHBOARD_STATUS_LABEL } from '../../types'
import AppIcon from '../common/AppIcon.vue'

const props = defineProps<{ status: DashboardStatus }>()

const label = computed(() => DASHBOARD_STATUS_LABEL[props.status])

const badgeClass = computed(() => {
  switch (props.status) {
    case 'generating':
      return 'bg-status-generating text-white'
    case 'completed':
      return 'bg-status-done/15 text-status-done border border-status-done/30'
    case 'published':
      return 'bg-status-published text-white'
    case 'needs_attention':
      return 'bg-status-attention text-white'
  }
})
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-full select-none"
    :class="badgeClass"
  >
    <span
      v-if="status === 'generating'"
      class="w-2 h-2 bg-white rounded-full animate-pulse-blue"
    ></span>
    <AppIcon
      v-else-if="status === 'needs_attention'"
      name="warning"
      :size="12"
    />
    {{ label }}
  </span>
</template>
