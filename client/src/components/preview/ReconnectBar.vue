<script setup lang="ts">
/**
 * SSE 断连提示细条（UX §7.3）：「连接中断，正在重连…」。
 * 断连期间预览与历史内容仍可正常查看、输入可用，此条只做提示，不遮挡操作。
 * 重连成功后把 visible 置 false 即可消失。
 *
 * ⚠ 集成注意：session store 目前尚无"连接状态"字段，先通过 visible prop 控制；
 *   待契约补上 connectionLost 后，由工作台页面接线（见返回给编排器的说明）。
 */
defineProps<{
  /** 是否处于断连重连中 */
  visible: boolean
}>()
</script>

<template>
  <div
    v-if="visible"
    class="flex h-7 w-full items-center justify-center gap-2 border-b border-line bg-status-attention-soft text-xs text-status-attention"
    role="alert"
  >
    <span class="inline-block h-1.5 w-1.5 animate-pulse-blue rounded-full bg-status-attention" aria-hidden="true"></span>
    连接中断，正在重连…
  </div>
</template>
