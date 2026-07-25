<!--
  右栏执行过程面板（UX §4.2）：
  - 空闲态收起为窄条（一句话当前状态，点击展开）；生成/修复/卡点/协助时自动展开，可手动折叠。
  - 展开宽 360px：顶部状态行 → 卡点行动区（仅卡点时，固定顶部高亮色）→ 人工协助卡（仅协助中）
    → 阶段时间线 + Issue 卡片（滚动区）→ 底部常驻「💬 遇到问题？呼叫人工协助」。
  - 版本抽屉打开时覆盖整个面板（UX §5.3）。
  用法（WorkbenchPage 组装时）：
    <ExecutionPanel />   // 自己接 session / chat store，无需 props
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import StageTimeline from './StageTimeline.vue'
import BlockerActionArea from './BlockerActionArea.vue'
import AssistCard from './AssistCard.vue'
import VersionDrawer from './VersionDrawer.vue'
import AppIcon from '../common/AppIcon.vue'
import { useVersionDrawer } from './useVersionDrawer'
import { emitLocateMessage } from './events'

const session = useSessionStore()
const chat = useChatStore()
const { versionDrawerOpen, closeVersionDrawer } = useVersionDrawer()

/* 状态行小圆点配色：生成中/协助中蓝色呼吸，等待澄清/卡点橙色，空闲灰 */
const statusDotCls = computed(() => {
  switch (session.runStatus) {
    case 'generating':
    case 'assisting':
      return 'bg-status-generating animate-pulse-blue'
    case 'awaiting_clarification':
    case 'blocked':
      return 'bg-status-attention'
    default:
      return 'bg-line-strong'
  }
})

/* 自动展开兜底：卡点出现 / 抽屉被顶栏打开时，即使窄条也先展开（store 已按 runStatus 处理常态） */
watch(() => session.blocker, (b) => { if (b) session.togglePanel(false) })
watch(versionDrawerOpen, (open) => { if (open) session.togglePanel(false) })

/* 行动区选项与对话区问题处理卡片同一入口（两处等效） */
function choose(optionId: string): void {
  // 「去回答」不走后端：与专用按钮等效，滚动定位到对话区澄清卡片
  if (optionId === 'opt-goto-answer') {
    if (session.blocker?.relatedMessageId) goAnswer(session.blocker.relatedMessageId)
    return
  }
  void chat.chooseOption(optionId)
}

/* 「去回答」：通知对话区滚动定位到澄清卡片 */
function goAnswer(messageId: string): void {
  emitLocateMessage(messageId)
}

/* 呼叫人工：可留一句话，也可直接呼叫 */
const assistFormOpen = ref(false)
const assistNote = ref('')
const assistSending = ref(false)

async function submitAssist(): Promise<void> {
  if (assistSending.value) return
  assistSending.value = true
  try {
    await session.callAssist(assistNote.value.trim() || undefined)
    assistNote.value = ''
    assistFormOpen.value = false
  } finally {
    assistSending.value = false
  }
}

async function onPreviewVersion(versionId: string): Promise<void> {
  await session.previewVersion(versionId)
}

async function onRollback(versionId: string): Promise<void> {
  await session.rollback(versionId)
}
</script>

<template>
  <!-- 收起态：窄条，一句话当前状态，点击展开 -->
  <button
    v-if="session.panelCollapsed"
    type="button"
    class="flex h-full w-11 shrink-0 flex-col items-center gap-2 border-l border-line bg-card py-3 hover:bg-panel"
    title="展开执行过程"
    @click="session.togglePanel(false)"
  >
    <AppIcon name="chevron-left" :size="14" class="text-ink-faint" />
    <span class="h-2 w-2 shrink-0 rounded-full" :class="statusDotCls" />
    <span class="text-xs text-ink-secondary [writing-mode:vertical-rl]">{{ session.statusText }}</span>
    <span v-if="session.blocker" class="mt-auto rounded-full bg-status-attention px-1 text-[11px] leading-4 text-white">!</span>
  </button>

  <!-- 展开态：宽度由工作台页面的拖拽分隔条控制（默认 360px） -->
  <aside v-else class="relative flex h-full w-full shrink-0 flex-col border-l border-line bg-card">
    <!-- 顶部状态行 -->
    <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
      <span class="h-2 w-2 shrink-0 rounded-full" :class="statusDotCls" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-ink">{{ session.statusText }}</p>
        <p v-if="session.stages.length" class="text-xs text-ink-faint">已完成 {{ session.stageProgress }} 步</p>
      </div>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-xs text-ink-faint hover:bg-panel hover:text-ink"
        title="收起"
        @click="session.togglePanel(true)"
      ><AppIcon name="chevron-right" :size="14" /></button>
    </header>

    <!-- 卡点行动区：仅卡点时固定在面板顶部，高亮色 -->
    <div v-if="session.blocker" class="shrink-0 px-3 pt-3">
      <BlockerActionArea :blocker="session.blocker" @choose="choose" @go-answer="goAnswer" />
    </div>

    <!-- 人工协助卡：仅协助中 -->
    <div v-if="session.assistSession" class="shrink-0 px-3 pt-3">
      <AssistCard :assist="session.assistSession" @end="session.endAssist()" />
    </div>

    <!-- 滚动区：阶段时间线 + Issue 卡片 -->
    <div class="flex-1 overflow-y-auto px-4 py-3">
      <StageTimeline v-if="session.stages.length" :stages="session.stages" :issues="session.issues" />
      <p v-else class="mt-8 text-center text-sm leading-6 text-ink-faint">
        还没有开始干活<br />在左侧说说你想要什么大屏吧
      </p>
    </div>

    <!-- 底部常驻：呼叫人工协助（非卡点时也在，降低求助门槛） -->
    <footer v-if="!session.assistSession" class="shrink-0 border-t border-line p-3">
      <div v-if="assistFormOpen" class="flex flex-col gap-2">
        <input
          v-model="assistNote"
          type="text"
          placeholder="一句话说说遇到什么问题（可不填）"
          class="w-full rounded-control border border-line bg-card px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
          @keydown.enter="submitAssist"
        />
        <div class="flex gap-2">
          <button
            type="button"
            class="flex-1 rounded-control bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover active:bg-primary-active disabled:opacity-50"
            :disabled="assistSending"
            @click="submitAssist"
          >{{ assistSending ? '正在呼叫…' : '呼叫人工协助' }}</button>
          <button
            type="button"
            class="rounded-control border border-line bg-card px-3 py-1.5 text-sm text-ink-secondary hover:bg-panel"
            @click="assistFormOpen = false; assistNote = ''"
          >取消</button>
        </div>
      </div>
      <button
        v-else
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-card border border-line bg-card px-3 py-2 text-sm text-ink-secondary shadow-card hover:border-primary-border hover:text-primary"
        @click="assistFormOpen = true"
      ><AppIcon name="chat-bubble" :size="16" /> 遇到问题？呼叫人工协助</button>
    </footer>

    <!-- 版本抽屉：覆盖整个面板（顶栏「↩版本」打开） -->
    <VersionDrawer
      v-if="versionDrawerOpen"
      :versions="session.versions"
      :can-rollback="session.canRollback"
      @close="closeVersionDrawer"
      @preview="onPreviewVersion"
      @rollback="onRollback"
    />
  </aside>
</template>
