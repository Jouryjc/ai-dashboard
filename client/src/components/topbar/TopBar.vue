<script setup lang="ts">
/**
 * 顶栏（UX §4.2 顶栏）。
 * - ← 返回首页（emit back，由工作台页面负责 session.close() + 跳转）
 * - 大屏标题：点击可改名（内联编辑，Enter/失焦保存，Esc 取消）
 * - 版本指示：v3 ●已保存（绿点）/ ●生成中（蓝点呼吸）/ ●有未发布修改（橙点）
 * - 右侧操作：⛶全屏（演示模式）/ ↩版本（emit openVersions 打开版本抽屉）/ ⚙设置 / ⋯菜单（含置灰的「开发者视图」）
 * - 查看历史版本时，顶栏下方出现横幅「正在查看历史版本 vX」+「返回当前」
 * 数据源：useSessionStore；改名落库走 useDashboardsStore.rename。
 */
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'
import { useSessionStore } from '../../stores/session'
import { useDashboardsStore } from '../../stores/dashboards'
import { fetchTextAsDownload, sanitizeFilename } from '../../utils/download'
import { openExternal } from '../../utils/open-external'
import PresentationOverlay from '../preview/PresentationOverlay.vue'
import PublishModal from './PublishModal.vue'
import AppIcon from '../common/AppIcon.vue'

const emit = defineEmits<{
  /** 点击 ←：返回首页（工作台页面负责关闭会话并跳转） */
  (e: 'back'): void
  /** 点击 ↩版本：打开版本时间线抽屉 */
  (e: 'openVersions'): void
}>()

const router = useRouter()
const session = useSessionStore()
const dashboards = useDashboardsStore()

/* ---------- 标题内联改名 ---------- */
const editing = ref(false)
const draft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

async function startEdit(): Promise<void> {
  draft.value = session.dashboardName
  editing.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

async function commitEdit(): Promise<void> {
  const name = draft.value.trim()
  editing.value = false
  if (!name || name === session.dashboardName || !session.dashboardId) return
  await dashboards.rename(session.dashboardId, name)
  // 同步顶栏显示（dashboards store 只管首页卡片列表）
  session.dashboardName = name
}

function cancelEdit(): void {
  editing.value = false
}

/* ---------- 版本指示（v3 ●已保存 / ●生成中 / ●有未发布修改） ---------- */
type VersionView =
  | { kind: 'generating' }
  | { kind: 'unpublished'; label: string }
  | { kind: 'saved'; label: string }
  | { kind: 'none' }

const versionView = computed<VersionView>(() => {
  if (session.runStatus === 'generating') return { kind: 'generating' }
  const cur = session.versions.find((v) => v.isCurrent)
  if (!cur) return { kind: 'none' }
  return cur.published
    ? { kind: 'saved', label: cur.label }
    : { kind: 'unpublished', label: cur.label }
})

/** 当前版本的公网访问地址（已发布且有 publicUrl 才有值，用于「打开预览」按钮） */
const publishedUrl = computed(() => {
  const cur = session.versions.find((v) => v.isCurrent)
  return cur?.published ? cur.publicUrl : undefined
})

/* ---------- 历史版本横幅 ---------- */
const viewingLabel = computed(
  () => session.versions.find((v) => v.id === session.viewingVersionId)?.label ?? ''
)
async function backToCurrent(): Promise<void> {
  await session.backToCurrent()
}

/* ---------- 全屏演示模式 ---------- */
const presenting = ref(false)

/* ---------- ⋯ 菜单 ---------- */
const menuOpen = ref(false)

function goSettings(): void {
  void router.push('/settings')
}

/* ---------- 发布（全流程托管在 PublishModal 弹窗） ---------- */
/** 当前版本（导出代码 + 发布弹窗确认页都用） */
const currentVersion = computed(() => session.versions.find((v) => v.isCurrent) ?? null)
/** 发布弹窗是否打开（idle/进度/成功/失败 全在弹窗内） */
const publishModalOpen = ref(false)

function askPublish(): void {
  menuOpen.value = false
  publishModalOpen.value = true
}

/* ---------- 导出当前版本代码 ---------- */
const canExportCurrent = computed(() => Boolean(currentVersion.value && session.dashboardId))

function exportCurrentVersion(): void {
  menuOpen.value = false
  const cur = currentVersion.value
  if (!cur || !session.dashboardId) return
  const url = api.exportVersionUrl(session.dashboardId, cur.id)
  const extension = session.artifactKind === 'idux-page' ? 'zip' : 'html'
  const filename = `${sanitizeFilename(session.dashboardName)}-${cur.label}.${extension}`
  void fetchTextAsDownload(url, filename).catch(() => {
    /* 静默失败：导出失败不打断使用 */
  })
}
</script>

<template>
  <header class="relative z-30 flex flex-col border-b border-line bg-card">
    <div class="flex h-12 items-center gap-2 px-3">
      <!-- ← 返回首页 -->
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-control text-ink-secondary hover:bg-panel hover:text-ink"
        title="返回首页"
        aria-label="返回首页"
        @click="emit('back')"
      >
        <AppIcon name="arrow-back" :size="16" />
      </button>

      <!-- 大屏标题：点击改名 -->
      <div class="flex min-w-0 items-center gap-2">
        <input
          v-if="editing"
          ref="titleInput"
          v-model="draft"
          class="h-7 w-56 rounded-control border border-primary-border bg-card px-2 text-sm font-medium text-ink outline-none focus:border-primary"
          maxlength="30"
          aria-label="大屏名称"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="cancelEdit"
          @blur="commitEdit"
        />
        <button
          v-else
          type="button"
          class="max-w-72 truncate rounded-control px-1.5 py-1 text-sm font-medium text-ink hover:bg-panel"
          title="点击改名"
          @click="startEdit"
        >
          {{ session.dashboardName || (session.artifactKind === 'idux-page' ? '未命名页面' : '未命名大屏') }}
        </button>

        <!-- 版本指示 -->
        <span v-if="versionView.kind === 'generating'" class="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span class="h-1.5 w-1.5 animate-pulse-blue rounded-full bg-status-generating" aria-hidden="true"></span>
          生成中
        </span>
        <span v-else-if="versionView.kind === 'unpublished'" class="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span class="h-1.5 w-1.5 rounded-full bg-status-attention" aria-hidden="true"></span>
          {{ versionView.label }} · 有未发布修改
        </span>
        <span v-else-if="versionView.kind === 'saved'" class="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span class="h-1.5 w-1.5 rounded-full bg-status-done" aria-hidden="true"></span>
          {{ versionView.label }} · 已保存
        </span>
        <!-- 已发布且有公网地址：打开预览（系统默认浏览器） -->
        <button
          v-if="publishedUrl"
          type="button"
          class="flex items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-primary hover:bg-primary-soft"
          :title="`在新窗口打开公网大屏：${publishedUrl}`"
          @click="openExternal(publishedUrl)"
        >
          <AppIcon name="open-in-new" :size="13" />
          打开预览
        </button>
      </div>

      <div class="flex-1"></div>

      <!-- 右侧操作 -->
      <div class="flex items-center gap-1">
        <!-- ⛶ 全屏演示 -->
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-control px-2 text-xs text-ink-secondary hover:bg-panel hover:text-ink"
          title="全屏演示（按 Esc 退出）"
          @click="presenting = true"
        >
          <AppIcon name="fullscreen" :size="14" />
          全屏
        </button>

        <!-- ↩ 版本抽屉 -->
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-control px-2 text-xs text-ink-secondary hover:bg-panel hover:text-ink"
          title="查看历史版本"
          @click="emit('openVersions')"
        >
          <AppIcon name="history" :size="14" />
          版本
        </button>

        <!-- ⚙ 设置 -->
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-control text-ink-secondary hover:bg-panel hover:text-ink"
          title="设置"
          aria-label="设置"
          @click="goSettings"
        >
          <AppIcon name="settings" :size="15" />
        </button>

        <!-- ⋯ 菜单 -->
        <div class="relative">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-control text-ink-secondary hover:bg-panel hover:text-ink"
            title="更多"
            aria-label="更多"
            :aria-expanded="menuOpen"
            @click="menuOpen = !menuOpen"
          >
            <AppIcon name="more-vert" :size="15" />
          </button>
          <button
            v-if="menuOpen"
            type="button"
            class="fixed inset-0 z-10 cursor-default"
            aria-label="收起菜单"
            @click="menuOpen = false"
          ></button>
          <ul
            v-if="menuOpen"
            class="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-card border border-line bg-card py-1 shadow-pop"
          >
            <li>
              <!-- 发布（F6）：空闲且有可用版本时才能点；点开发布弹窗全流程托管 -->
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs"
                :class="session.canPublish ? 'text-ink hover:bg-primary-soft' : 'cursor-not-allowed text-ink-faint'"
                :disabled="!session.canPublish"
                :title="session.canPublish ? '' : '做好一版并且空闲时才能发布'"
                @click="askPublish"
              >
                发布
              </button>
            </li>
            <li>
              <!-- 大屏导出 HTML，IDux 普通页面导出可复现的 Vue 源码 ZIP -->
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs"
                :class="canExportCurrent ? 'text-ink hover:bg-primary-soft' : 'cursor-not-allowed text-ink-faint'"
                :disabled="!canExportCurrent"
                :title="canExportCurrent ? '' : '还没有做好的版本'"
                @click="exportCurrentVersion"
              >
                导出当前版本代码
              </button>
            </li>
            <li>
              <!-- 开发者视图：暂未开放（UX §4.2：默认隐藏，给客服/研发远程指导时用） -->
              <button
                type="button"
                class="flex w-full cursor-not-allowed items-center justify-between px-3 py-1.5 text-left text-xs text-ink-faint"
                disabled
                title="暂未开放"
              >
                开发者视图
                <span class="text-[10px]">暂未开放</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 正在查看历史版本横幅 -->
    <div
      v-if="session.viewingVersionId"
      class="flex h-8 items-center justify-center gap-3 border-t border-line bg-status-attention-soft text-xs text-ink"
      role="status"
    >
      <span>正在查看历史版本 {{ viewingLabel }}，做的修改不会用到这个版本上</span>
      <button
        type="button"
        class="rounded-control bg-card px-2 py-0.5 text-xs text-primary shadow-card hover:bg-primary-soft"
        @click="backToCurrent"
      >
        返回当前
      </button>
    </div>

    <!-- 全屏演示模式（覆盖全窗口，Esc 退出） -->
    <PresentationOverlay v-if="presenting" @exit="presenting = false" />

    <!-- 发布弹窗（全流程托管：确认 → 进度 → 成功/失败） -->
    <PublishModal v-if="publishModalOpen" @close="publishModalOpen = false" />
  </header>
</template>
