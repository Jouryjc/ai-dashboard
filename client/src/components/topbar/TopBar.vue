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
import PresentationOverlay from '../preview/PresentationOverlay.vue'
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

/* ---------- 发布（F6：非管理员 = 提交发布申请，先弹确认） ---------- */
const publishConfirmOpen = ref(false)
/** 当前版本（确认弹窗里展示截图预览 + 变更摘要，UX §5.6） */
const currentVersion = computed(() => session.versions.find((v) => v.isCurrent) ?? null)

function askPublish(): void {
  menuOpen.value = false
  publishConfirmOpen.value = true
}

/* ---------- 导出当前版本代码 ---------- */
const canExportCurrent = computed(() => Boolean(currentVersion.value && session.dashboardId))

function exportCurrentVersion(): void {
  menuOpen.value = false
  const cur = currentVersion.value
  if (!cur || !session.dashboardId) return
  const url = api.exportVersionUrl(session.dashboardId, cur.id)
  const filename = `${sanitizeFilename(session.dashboardName)}-${cur.label}.html`
  void fetchTextAsDownload(url, filename).catch(() => {
    /* 静默失败：导出失败不打断使用 */
  })
}

async function confirmPublish(): Promise<void> {
  publishConfirmOpen.value = false
  await session.publish()
  // 等待审批期间展开右栏执行面板，让用户看到「等待审批」阶段
  session.togglePanel(false)
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
          {{ session.dashboardName || '未命名大屏' }}
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
              <!-- 提交发布申请（F6）：空闲且有可用版本时才能点 -->
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs"
                :class="session.canPublish ? 'text-ink hover:bg-primary-soft' : 'cursor-not-allowed text-ink-faint'"
                :disabled="!session.canPublish"
                :title="session.canPublish ? '' : '做好一版并且空闲时才能发布'"
                @click="askPublish"
              >
                提交发布申请
              </button>
            </li>
            <li>
              <!-- 导出当前版本代码：下载该版本的完整 HTML -->
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

    <!-- 发布确认（F6：提交发布申请，管理员审批后正式发布） -->
    <Teleport to="body">
      <div
        v-if="publishConfirmOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-ink/40"
        role="dialog"
        aria-label="提交发布申请"
        @click.self="publishConfirmOpen = false"
      >
        <div class="w-80 rounded-card bg-card p-5 shadow-pop">
          <p class="text-sm font-medium text-ink">提交发布申请？</p>
          <!-- 截图预览（UX §5.6） -->
          <img
            v-if="currentVersion?.screenshotUrl"
            :src="currentVersion.screenshotUrl"
            alt="当前版本截图"
            class="mt-3 aspect-video w-full rounded-control border border-line object-cover"
          />
          <div class="mt-3 rounded-control bg-panel px-3 py-2 text-xs leading-5 text-ink-secondary">
            <p>大屏：「{{ session.dashboardName }}」{{ currentVersion?.label ?? '' }}</p>
            <p class="mt-0.5">本次改动：{{ currentVersion?.summary || '无说明' }}</p>
          </div>
          <p class="mt-2 text-xs leading-5 text-ink-secondary">
            提交给管理员审批，通过后正式发布，审批结果会第一时间通知你。
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-control border border-line bg-card px-3 py-1.5 text-sm text-ink-secondary hover:bg-panel"
              @click="publishConfirmOpen = false"
            >再想想</button>
            <button
              type="button"
              class="rounded-control bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover active:bg-primary-active"
              @click="confirmPublish"
            >提交申请</button>
          </div>
        </div>
      </div>
    </Teleport>
  </header>
</template>
