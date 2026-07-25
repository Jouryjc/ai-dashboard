<script setup lang="ts">
/**
 * 工作台（三栏一屏式：对话 / 预览 / 执行面板）—— UX §4.1，集成阶段组装。
 * - 顶栏 TopBar（← 返回 / 标题改名 / 版本指示 / ⛶全屏 / ↩版本 / ⚙ / ⋯）
 * - 左栏对话区 ChatPanel（默认 320px）、中区预览 PreviewPanel、右栏执行面板 ExecutionPanel
 *   （默认 360px，空闲收起为窄条、任务中自动展开 —— 由 session.panelCollapsed 驱动）
 * - 两条拖拽分隔条调宽，布局记忆到 localStorage；窗口宽 <1200 时右栏自动折叠（UX §8）
 * - ↩版本 打开 VersionDrawer（覆盖右栏位置，开关见 useVersionDrawer 单例）
 * - 路由 query ?focus=blocker（首页"需要处理"卡片进来）→ 展开右栏并滚动到对话区卡点卡片
 * - 右栏"去回答"（LOCATE_MESSAGE_EVENT）→ 滚动定位到对话区澄清/问题卡片
 * - 断线重连细条 ReconnectBar（api-connection 事件，mock 模拟与 HTTP 真实断线共用，UX §7.3）
 * - 桌面通知（UX §7.4 四个时机：生成完成 / 卡点需要操作 / 人工协助接入 / 审批结果）
 * 数据源：useSessionStore + useChatStore；进入 session.open(id)，离开 session.close()。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import TopBar from '../components/topbar/TopBar.vue'
import ChatPanel from '../components/chat/ChatPanel.vue'
import PreviewPanel from '../components/preview/PreviewPanel.vue'
import ReconnectBar from '../components/preview/ReconnectBar.vue'
import ExecutionPanel from '../components/execution/ExecutionPanel.vue'
import { useVersionDrawer } from '../components/execution/useVersionDrawer'
import { LOCATE_MESSAGE_EVENT } from '../components/execution/events'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const chat = useChatStore()
const { openVersionDrawer } = useVersionDrawer()

/* ==================== 进入 / 离开 ==================== */

async function openSession(id: string): Promise<void> {
  if (!id || id === session.dashboardId) return
  await session.open(id)
}

function onBack(): void {
  session.close()
  void router.push('/')
}

/* 直接改地址栏跳到另一个大屏时（很少见）重新打开会话 */
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === 'string') void openSession(id)
  }
)

/* ==================== 对话区滚动定位（去回答 / ?focus=blocker） ==================== */

async function scrollToMessage(messageId: string): Promise<void> {
  await nextTick()
  document
    .getElementById(`chat-msg-${messageId}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function onLocateMessage(e: Event): void {
  const id = (e as CustomEvent<{ messageId: string }>).detail?.messageId
  if (id) void scrollToMessage(id)
}

/** 首页"需要处理"卡片带 ?focus=blocker 进来：展开右栏 + 滚动到对话区卡点卡片 */
async function applyFocusQuery(): Promise<void> {
  if (route.query.focus !== 'blocker') return
  session.togglePanel(false)
  const target =
    session.blocker?.relatedMessageId ?? chat.activeProblem?.id ?? chat.latestClarification?.id
  if (target) await scrollToMessage(target)
}

/* ==================== 三栏宽度：拖拽分隔条 + 布局记忆 ==================== */

const LAYOUT_KEY = 'ai-dashboard.workbench.layout'
const LEFT_DEFAULT = 320
const RIGHT_DEFAULT = 360

const leftWidth = ref(LEFT_DEFAULT)
const rightWidth = ref(RIGHT_DEFAULT)

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function loadLayout(): void {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { left?: number; right?: number }
    if (typeof saved.left === 'number') leftWidth.value = clamp(saved.left, 260, 480)
    if (typeof saved.right === 'number') rightWidth.value = clamp(saved.right, 300, 560)
  } catch {
    /* 本地数据坏了就用默认值 */
  }
}

function persistLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left: leftWidth.value, right: rightWidth.value }))
  } catch {
    /* 存不进去就算了，不影响使用 */
  }
}

function startDrag(which: 'left' | 'right', e: PointerEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startLeft = leftWidth.value
  const startRight = rightWidth.value
  const move = (ev: PointerEvent): void => {
    const dx = ev.clientX - startX
    if (which === 'left') leftWidth.value = clamp(startLeft + dx, 260, 480)
    else rightWidth.value = clamp(startRight - dx, 300, 560)
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    persistLayout()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/* 窗口宽 <1200（最小窗口）时右栏自动折叠为窄条（UX §8）；拉宽后不替用户做决定，保持当前状态 */
function onWindowResize(): void {
  if (window.innerWidth < 1200 && !session.panelCollapsed) session.togglePanel(true)
}

/* ==================== 断线重连细条（UX §7.3，mock 引擎调试钩子驱动） ==================== */

const connected = ref(true)
function onConnection(e: Event): void {
  connected.value = (e as CustomEvent<{ connected: boolean }>).detail?.connected !== false
}

/* ==================== 桌面通知（UX §7.4，四个时机，克制） ==================== */

/**
 * 发系统通知。onClick = 点击后"直达工作台对应位置"（UX §7.4）：
 * 聚焦窗口 + 展开右栏 / 滚动到相关卡片，由调用方按通知类型给定。
 */
function notify(title: string, body: string, onClick?: () => void): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  const n = new Notification(title, { body })
  n.onclick = () => {
    window.focus()
    onClick?.()
  }
}

/** 点击"需要你处理"类通知：展开右栏 + 滚动定位到对话区对应卡片 */
function locateBlocker(relatedMessageId: string | null): void {
  session.togglePanel(false)
  if (relatedMessageId) void scrollToMessage(relatedMessageId)
}

const apiOffs: Array<() => void> = []

function subscribeNotifications(): void {
  const forCurrent = (p: { dashboardId: string }): boolean => p.dashboardId === session.dashboardId
  apiOffs.push(
    // 1. 生成完成（构建走到 ready 才通知；预览/回退历史版本时 runStatus 是空闲，不会误报）
    api.on('previewReady', (p) => {
      if (!forCurrent(p) || session.runStatus !== 'generating') return
      notify('你的大屏做好了', `「${session.dashboardName}」有新版本了，回来看看效果`)
    }),
    // 2. 卡点需要操作（含等待澄清）：点击直达卡点行动区/对话区卡片
    api.on('blocker', (p) => {
      if (!forCurrent(p) || !p.blocker) return
      const blk = p.blocker
      notify('需要你处理', `${blk.title}：${blk.description}`, () => locateBlocker(blk.relatedMessageId))
    }),
    // 3. 人工协助接入：点击展开右栏看协助过程
    api.on('assist', (p) => {
      if (!forCurrent(p) || !p.session) return
      notify('支持人员已接入', `${p.session.operatorName} 正在协助你，每一步操作你都能在右侧看到`, () =>
        session.togglePanel(false)
      )
    }),
    // 4. 审批结果（发布申请通过）：点击展开右栏看版本 ★ 标
    api.on('dashboardUpdated', ({ dashboard }) => {
      if (dashboard.id !== session.dashboardId || dashboard.status !== 'published') return
      notify('发布申请已通过', `「${dashboard.name}」已正式发布`, () => session.togglePanel(false))
    })
  )
}

/* ==================== 生命周期 ==================== */

onMounted(async () => {
  loadLayout()
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission()
  }
  window.addEventListener('resize', onWindowResize)
  window.addEventListener(LOCATE_MESSAGE_EVENT, onLocateMessage)
  window.addEventListener('api-connection', onConnection)
  await openSession(route.params.id as string)
  onWindowResize()
  subscribeNotifications()
  await applyFocusQuery()
})

onBeforeUnmount(() => {
  apiOffs.forEach((off) => off())
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener(LOCATE_MESSAGE_EVENT, onLocateMessage)
  window.removeEventListener('api-connection', onConnection)
  session.close()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-page text-ink">
    <!-- 顶栏：← 返回 / 标题 / 版本指示 / ⛶全屏 / ↩版本 / ⚙ / ⋯（含历史版本横幅与全屏演示） -->
    <TopBar @back="onBack" @open-versions="openVersionDrawer" />

    <!-- 断线重连细条（UX §7.3） -->
    <ReconnectBar :visible="!connected" />

    <!-- 三栏 -->
    <div class="flex min-h-0 flex-1">
      <!-- 左栏：对话区（默认 320px，可拖 260~480） -->
      <div class="h-full shrink-0 overflow-hidden" :style="{ width: `${leftWidth}px` }">
        <ChatPanel />
      </div>

      <!-- 分隔条：左栏 ↔ 中区 -->
      <div
        class="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center hover:bg-primary-soft"
        role="separator"
        aria-orientation="vertical"
        title="拖动调整对话区宽度"
        @pointerdown="startDrag('left', $event)"
      >
        <span class="h-8 w-0.5 rounded-full bg-line group-hover:bg-primary-border" />
      </div>

      <!-- 中区：大屏预览区 -->
      <div class="min-w-0 flex-1">
        <PreviewPanel />
      </div>

      <!-- 分隔条：中区 ↔ 右栏（右栏收起为窄条时不显示） -->
      <div
        v-if="!session.panelCollapsed"
        class="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center hover:bg-primary-soft"
        role="separator"
        aria-orientation="vertical"
        title="拖动调整执行面板宽度"
        @pointerdown="startDrag('right', $event)"
      >
        <span class="h-8 w-0.5 rounded-full bg-line group-hover:bg-primary-border" />
      </div>

      <!-- 右栏：执行面板（默认 360px，可拖 300~560；收起时是窄条，宽度由组件自身决定） -->
      <div
        class="h-full shrink-0 overflow-hidden"
        :style="session.panelCollapsed ? undefined : { width: `${rightWidth}px` }"
      >
        <ExecutionPanel />
      </div>
    </div>
  </div>
</template>
