<script setup lang="ts">
/**
 * 首页（我的大屏）—— UX §3。
 * 布局还原 stitch-reference/home-a.html：固定顶栏 + 左侧导航 + 卡片网格 + 底部状态条。
 * 数据源：useDashboardsStore（src/stores/dashboards.ts），组件只读 store、只调 store action。
 *
 * 交互：
 *  - 「＋ 新建大屏」固定首位，点击新建并跳转 /workbench/:id
 *  - 单击卡片进工作台；「需要处理」卡片带 ?focus=blocker 定位标记（工作台据此定位卡点行动区）
 *  - 双击封面全屏预览（PreviewOverlay）
 *  - 搜索框按名称过滤；卡片支持行内改名与删除（二次确认）
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDashboardsStore } from '../stores/dashboards'
import type { ArtifactKind, Dashboard } from '../types'
import HomeTopbar from '../components/home/HomeTopbar.vue'
import HomeSidebar from '../components/home/HomeSidebar.vue'
import DashboardCard from '../components/home/DashboardCard.vue'
import NewDashboardCard from '../components/home/NewDashboardCard.vue'
import PreviewOverlay from '../components/home/PreviewOverlay.vue'
import ConfirmDialog from '../components/home/ConfirmDialog.vue'
import AppIcon from '../components/common/AppIcon.vue'

const router = useRouter()
const store = useDashboardsStore()

/* ---- 顶栏 / 侧栏 ---- */
const keyword = ref('')
const sidebarOpen = ref(true)

/* ---- 相对时间每 30 秒刷新一次（"2 分钟前"会自动往前走） ---- */
const now = ref(Date.now())
let clock: number | undefined

onMounted(() => {
  store.fetchAll()
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 30000)
})
onUnmounted(() => window.clearInterval(clock))

/* ---- 搜索过滤（按名称，大小写不敏感） ---- */
const filtered = computed<Dashboard[]>(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return store.sorted
  return store.sorted.filter((d) => d.name.toLowerCase().includes(k))
})

const showSkeleton = computed(() => store.loading && !store.loaded)

/* ---- 新建项目：先明确产物类型，创建后锁定，避免意图路由把表格误生成成大屏 ---- */
const creating = ref(false)
const createChooserOpen = ref(false)
async function onCreate(artifactKind: ArtifactKind): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    const d = await store.create(
      artifactKind === 'dashboard' ? '新大屏' : '新业务应用',
      artifactKind
    )
    createChooserOpen.value = false
    router.push(`/workbench/${d.id}`)
  } finally {
    creating.value = false
  }
}

/* ---- 打开工作台：需要处理的卡片带定位标记 ---- */
function openDashboard(d: Dashboard): void {
  if (d.status === 'needs_attention') {
    router.push({ path: `/workbench/${d.id}`, query: { focus: 'blocker' } })
  } else {
    router.push(`/workbench/${d.id}`)
  }
}

/* ---- 双击封面：全屏预览 ---- */
const previewing = ref<Dashboard | null>(null)

/* ---- 改名 / 删除 ---- */
async function onRename(id: string, name: string): Promise<void> {
  await store.rename(id, name)
}

const deleting = ref<Dashboard | null>(null)
const deleteBusy = ref(false)
async function confirmDelete(): Promise<void> {
  if (!deleting.value || deleteBusy.value) return
  deleteBusy.value = true
  try {
    await store.remove(deleting.value.id)
    deleting.value = null
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <div class="min-h-full bg-page text-ink">
    <HomeTopbar v-model:keyword="keyword" @toggle-sidebar="sidebarOpen = !sidebarOpen" />
    <HomeSidebar v-if="sidebarOpen" />

    <!-- 主内容区 -->
    <main
      class="pt-16 pb-12 transition-[margin] duration-200"
      :class="sidebarOpen ? 'ml-[260px]' : 'ml-0'"
    >
      <div class="p-8">
        <header class="mb-10">
          <h1 class="text-3xl font-bold text-ink mb-2">首页 · 我的项目</h1>
          <p class="text-ink-secondary text-lg">数据大屏和业务应用都在这里，类型清晰、版本独立。</p>
        </header>

        <!-- 首次加载骨架 -->
        <div
          v-if="showSkeleton"
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
        >
          <div
            v-for="i in 5"
            :key="i"
            class="h-[280px] bg-card border border-line rounded-card animate-pulse"
          ></div>
        </div>

        <!-- 卡片网格：新建固定首位 -->
        <div
          v-else
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
        >
          <NewDashboardCard :creating="creating" @create="createChooserOpen = true" />
          <DashboardCard
            v-for="d in filtered"
            :key="d.id"
            :dashboard="d"
            :now="now"
            @open="openDashboard"
            @preview="previewing = $event"
            @rename="onRename"
            @remove="deleting = $event"
          />
        </div>

        <!-- 搜索无结果 -->
        <p
          v-if="!showSkeleton && keyword.trim() && filtered.length === 0"
          class="mt-8 text-sm text-ink-secondary"
        >
          没有找到名字里带「{{ keyword.trim() }}」的项目，换个词试试。
        </p>
      </div>
    </main>

    <!-- 底部状态条 -->
    <footer
      class="fixed bottom-0 left-0 w-full z-50 bg-panel/80 backdrop-blur-md h-12 flex items-center justify-between px-6 border-t border-line"
    >
      <div class="flex items-center gap-2 text-ink-secondary text-sm">
        <AppIcon name="info" :size="18" class="text-primary" />
        <span>双击卡片封面可全屏预览，单击进入工作台继续编辑</span>
      </div>
      <div class="hidden sm:flex items-center gap-6 text-ink-secondary text-xs font-medium">
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 bg-status-done rounded-full"></span>
          系统运行正常
        </div>
        <div class="tracking-wide">© 2026 AI 大屏工作台</div>
      </div>
    </footer>

    <!-- 全屏预览 / 删除确认 -->
    <PreviewOverlay
      v-if="previewing"
      :dashboard="previewing"
      @close="previewing = null"
      @open="(d) => { previewing = null; openDashboard(d) }"
    />
    <ConfirmDialog
      v-if="deleting"
      :dashboard="deleting"
      :busy="deleteBusy"
      @cancel="deleting = null"
      @confirm="confirmDelete"
    />

    <div
      v-if="createChooserOpen"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-ink/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-title"
      @click.self="createChooserOpen = false"
    >
      <section class="w-full max-w-2xl rounded-card border border-line bg-card p-6 shadow-pop">
        <div class="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="create-project-title" class="text-xl font-bold text-ink">这次要生成什么？</h2>
            <p class="mt-1 text-sm text-ink-secondary">类型创建后锁定，避免普通表格被误路由成大屏。</p>
          </div>
          <button
            type="button"
            class="rounded-control p-1 text-ink-secondary hover:bg-panel"
            aria-label="关闭"
            @click="createChooserOpen = false"
          >
            <AppIcon name="close" :size="20" />
          </button>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            class="rounded-card border border-line p-5 text-left transition hover:border-primary hover:bg-primary-soft/40 focus:outline-none focus:ring-2 focus:ring-primary"
            :disabled="creating"
            @click="onCreate('dashboard')"
          >
            <span class="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary">
              <AppIcon name="monitor" :size="22" />
            </span>
            <strong class="block text-base text-ink">数据大屏</strong>
            <span class="mt-1 block text-sm leading-6 text-ink-secondary">固定画布、指标卡和可视化，适合展示与汇报。</span>
          </button>
          <button
            type="button"
            class="rounded-card border border-line p-5 text-left transition hover:border-primary hover:bg-primary-soft/40 focus:outline-none focus:ring-2 focus:ring-primary"
            :disabled="creating"
            @click="onCreate('business-app')"
          >
            <span class="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary">
              <AppIcon name="database" :size="22" />
            </span>
            <strong class="block text-base text-ink">业务应用</strong>
            <span class="mt-1 block text-sm leading-6 text-ink-secondary">可交互的列表、详情、表单和业务操作，可导出 Vue 源码。</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
