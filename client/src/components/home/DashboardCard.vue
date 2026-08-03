<script setup lang="ts">
/**
 * 大屏卡片：封面缩略图 + 名称 + 四种状态徽标 + 最近修改时间（大白话）。
 * 单击卡片 = 进入工作台；双击封面 = 全屏预览（父组件处理路由与 overlay）。
 * 卡片上的改名/删除按钮通过 emit 交给父组件调 store。
 */
import { computed, nextTick, ref } from 'vue'
import type { Dashboard } from '../../types'
import StatusBadge from './StatusBadge.vue'
import AppIcon from '../common/AppIcon.vue'
import { relativeTime } from './relativeTime'

const props = defineProps<{
  dashboard: Dashboard
  /** 父组件传来的"当前时间"刻度，用于让相对时间自动刷新 */
  now: number
}>()

const emit = defineEmits<{
  open: [dashboard: Dashboard]
  preview: [dashboard: Dashboard]
  rename: [id: string, name: string]
  remove: [dashboard: Dashboard]
}>()

const timeLabel = computed(() => relativeTime(props.dashboard.updatedAt, props.now))

/* ---- 单击 / 双击区分：单击延迟 240ms 触发，双击取消 ---- */
let clickTimer: number | undefined

function onCardClick(): void {
  window.clearTimeout(clickTimer)
  clickTimer = window.setTimeout(() => emit('open', props.dashboard), 240)
}

function onCoverDblClick(): void {
  window.clearTimeout(clickTimer)
  emit('preview', props.dashboard)
}

/* ---- 行内改名 ---- */
const editing = ref(false)
const draftName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

async function startRename(): Promise<void> {
  draftName.value = props.dashboard.name
  editing.value = true
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function commitRename(): void {
  if (!editing.value) return
  editing.value = false
  const name = draftName.value.trim()
  if (name && name !== props.dashboard.name) {
    emit('rename', props.dashboard.id, name)
  }
}

function cancelRename(): void {
  editing.value = false
}
</script>

<template>
  <div
    class="bg-card border border-line rounded-card overflow-hidden shadow-card hover:shadow-card-hover transition-shadow group cursor-pointer"
    @click="onCardClick"
  >
    <!-- 封面（双击全屏预览） -->
    <div class="relative h-44 overflow-hidden bg-panel" @dblclick.stop="onCoverDblClick">
      <img
        v-if="dashboard.coverUrl"
        class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
        :src="dashboard.coverUrl"
        :alt="dashboard.name"
      />
      <div
        v-else
        class="w-full h-full flex flex-col items-center justify-center text-ink-faint gap-2 select-none"
      >
        <AppIcon name="monitor" :size="40" />
        <span class="text-xs">还没有封面，进去说句话就开始生成</span>
      </div>
      <div class="absolute top-3 left-3">
        <StatusBadge :status="dashboard.status" />
      </div>
      <span class="absolute right-3 top-3 rounded-full bg-card/90 px-2 py-1 text-[11px] font-medium text-ink-secondary shadow-card">
        {{ dashboard.artifactKind === 'business-app' ? '业务应用' : '数据大屏' }}
      </span>
    </div>

    <!-- 名称 + 时间 + 操作 -->
    <div class="p-4">
      <div class="flex justify-between items-start mb-1 gap-2">
        <input
          v-if="editing"
          ref="nameInput"
          v-model="draftName"
          class="flex-1 min-w-0 font-bold text-ink bg-panel rounded-control px-2 py-0.5 outline-none focus:ring-2 focus:ring-primary"
          maxlength="30"
          @click.stop
          @blur="commitRename"
          @keydown.enter="commitRename"
          @keydown.esc="cancelRename"
        />
        <h3 v-else class="font-bold text-ink truncate pr-2" :title="dashboard.name">
          {{ dashboard.name }}
        </h3>
        <span class="text-xs text-ink-secondary shrink-0 pt-0.5">{{ timeLabel }}</span>
      </div>

      <div class="flex items-center justify-between mt-4">
        <div class="flex gap-1">
          <button
            class="p-1.5 rounded-control hover:bg-panel text-ink-secondary transition-colors"
            title="改名字"
            @click.stop="startRename"
          >
            <AppIcon name="edit" :size="18" />
          </button>
          <button
            class="p-1.5 rounded-control hover:bg-danger/10 text-danger/80 transition-colors"
            title="删除"
            @click.stop="emit('remove', dashboard)"
          >
            <AppIcon name="delete" :size="18" />
          </button>
        </div>
        <span
          v-if="dashboard.status === 'needs_attention'"
          class="text-xs text-status-attention font-medium select-none"
        >
          点进去看看
        </span>
        <span v-else class="text-xs text-ink-faint select-none opacity-0 group-hover:opacity-100 transition-opacity">
          双击封面可全屏看
        </span>
      </div>
    </div>
  </div>
</template>
