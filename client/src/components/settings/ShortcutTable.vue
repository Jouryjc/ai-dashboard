<script setup lang="ts">
/**
 * 快捷键一览表（UX §8：设置中提供，按平台显示 Ctrl 或 Cmd）。
 * Windows / Linux 用 Ctrl，macOS 用 Cmd。
 */
interface ShortcutRow {
  /** 大白话动作说明 */
  action: string
  /** 键帽序列，如 ['Ctrl', 'Enter'] */
  keys: string[]
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const mod = isMac ? 'Cmd' : 'Ctrl'

const ROWS: ShortcutRow[] = [
  { action: '发送消息', keys: ['Enter'] },
  { action: '发送消息（同效）', keys: [mod, 'Enter'] },
  { action: '换行（不发送）', keys: ['Shift', 'Enter'] },
  { action: '退出全屏演示', keys: ['Esc'] }
]
</script>

<template>
  <section class="rounded-card border border-line bg-card p-6 shadow-card">
    <h2 class="text-base font-semibold text-ink">快捷键一览</h2>
    <p class="mt-1 text-xs text-ink-faint">你的设备上按「{{ mod }}」键。</p>
    <ul class="mt-4 divide-y divide-line">
      <li
        v-for="row in ROWS"
        :key="row.action"
        class="flex items-center justify-between py-3"
      >
        <span class="text-sm text-ink">{{ row.action }}</span>
        <span class="flex items-center gap-1">
          <kbd
            v-for="key in row.keys"
            :key="key"
            class="rounded-control border border-line bg-panel px-2 py-1 text-xs font-medium text-ink-secondary"
          >{{ key }}</kbd>
        </span>
      </li>
    </ul>
  </section>
</template>
