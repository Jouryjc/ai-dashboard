<!--
  版本抽屉（UX §5.3）：覆盖在执行面板位置。
  节点：版本号 + 一句话摘要 + 相对时间 + ★已发布标 / 当前标；hover 显示缩略截图。
  [预览此版本] 顶栏横幅由 session.viewingVersionId 驱动；
  [回退到此版本] 二次确认（"会保留之后的记录，随时可以回来"）→ 生成新节点而非删除。
  打开入口在顶栏「↩版本」，开关状态见 useVersionDrawer.ts。
-->
<script setup lang="ts">
import { ref } from 'vue'
import type { Version } from '../../types'
import { formatRelativeTime } from './utils'
import AppIcon from '../common/AppIcon.vue'

defineProps<{
  versions: Version[]
  canRollback: boolean
}>()
const emit = defineEmits<{
  close: []
  preview: [versionId: string]
  rollback: [versionId: string]
}>()

/* 回退二次确认（行内展开，不弹窗） */
const confirmingId = ref<string | null>(null)

function confirmRollback(v: Version): void {
  emit('rollback', v.id)
  confirmingId.value = null
}
</script>

<template>
  <div class="absolute inset-0 z-10 flex flex-col bg-card">
    <header class="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
      <p class="text-sm font-medium text-ink">版本历史</p>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-control text-ink-faint hover:bg-panel hover:text-ink"
        title="关闭"
        @click="emit('close')"
      ><AppIcon name="close" :size="14" /></button>
    </header>

    <div class="flex-1 overflow-y-auto px-4 py-3">
      <p v-if="!versions.length" class="mt-8 text-center text-sm text-ink-faint">
        还没有版本<br />在左侧描述你想要的大屏，做好第一版后会出现在这里
      </p>

      <ol class="flex flex-col">
        <li v-for="(v, idx) in versions" :key="v.id" class="group relative flex gap-3">
          <!-- 节点圆点 + 连接竖线 -->
          <div class="flex w-4 shrink-0 flex-col items-center pt-1">
            <span
              class="h-3 w-3 rounded-full"
              :class="v.isCurrent ? 'bg-primary ring-4 ring-primary-soft' : 'border-2 border-line-strong bg-card'"
            />
            <span v-if="idx < versions.length - 1" class="mt-1 w-px flex-1 bg-line" />
          </div>

          <div class="min-w-0 flex-1 pb-4">
            <div class="flex items-center gap-1.5">
              <p class="text-sm font-medium text-ink">{{ v.label }}</p>
              <span v-if="v.isCurrent" class="rounded-control bg-primary-soft px-1 py-0.5 text-[11px] leading-none text-primary">当前</span>
              <span v-if="v.published" class="inline-flex items-center gap-0.5 rounded-control bg-primary-soft px-1 py-0.5 text-[11px] leading-none text-status-published"><AppIcon name="star" :size="11" /> 已发布</span>
            </div>
            <p class="mt-0.5 text-xs leading-5 text-ink-secondary">{{ v.summary }}</p>
            <p class="text-xs text-ink-faint">{{ formatRelativeTime(v.createdAt) }}</p>

            <!-- 操作：当前版本不给回退/预览（就是它本身） -->
            <div v-if="!v.isCurrent" class="mt-1.5 hidden gap-2 group-hover:flex">
              <button
                type="button"
                class="rounded-control border border-line bg-card px-2 py-1 text-xs text-primary hover:border-primary-border hover:bg-primary-soft"
                @click="emit('preview', v.id)"
              >预览此版本</button>
              <button
                type="button"
                class="rounded-control border border-line bg-card px-2 py-1 text-xs text-ink-secondary hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canRollback"
                :title="canRollback ? '' : '现在不能回退'"
                @click="confirmingId = v.id"
              >回退到此版本</button>
            </div>

            <!-- 回退二次确认（行内，不弹窗） -->
            <div v-if="confirmingId === v.id" class="mt-2 rounded-control border border-line bg-panel p-2.5">
              <p class="text-xs leading-5 text-ink">
                回退到 {{ v.label }}？会保留之后的记录，随时可以回来。
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  class="rounded-control bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary-hover"
                  @click="confirmRollback(v)"
                >确认回退</button>
                <button
                  type="button"
                  class="rounded-control border border-line bg-card px-2.5 py-1 text-xs text-ink-secondary hover:bg-panel"
                  @click="confirmingId = null"
                >取消</button>
              </div>
            </div>
          </div>

          <!-- hover 缩略截图（浮在抽屉左侧） -->
          <div class="pointer-events-none absolute right-full top-0 z-20 mr-2 hidden w-48 group-hover:block">
            <img
              v-if="v.screenshotUrl"
              :src="v.screenshotUrl"
              :alt="`${v.label} 截图`"
              class="w-full rounded-card border border-line object-cover shadow-pop"
            />
            <div v-else class="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-card bg-panel text-xs text-ink-faint shadow-pop">
              <AppIcon name="image" :size="20" />
              暂无截图
            </div>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>
