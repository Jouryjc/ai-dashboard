<script setup lang="ts">
/**
 * 对话输入区（UX §4.2）：
 *  - 多行输入，Enter 发送（Ctrl/⌘+Enter 同效），Shift+Enter 换行；
 *  - 输入框永不锁定：生成中也能发，消息自动排队，上方出现提示条
 *    "已收到，将在当前步骤后处理"（由父组件传 queueHint 控制）；
 *  - 📎 附件：支持文件选择与 Ctrl+V / ⌘+V 粘贴图片（仅多模态模式；
 *    纯文本模式置灰 + 粘贴时提示换模型）；
 *  - 🎤 语音：一期不做，常驻置灰。
 * 文案严格大白话，无技术术语。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useSessionStore } from '../../stores/session'
import { useSettingsStore } from '../../stores/settings'
import AppIcon from '../common/AppIcon.vue'

defineProps<{
  /** true 时在输入框上方显示"已收到，将在当前步骤后处理"提示条 */
  queueHint: boolean
}>()

/** 草稿（父组件 ChatPanel 的示例话术 chips 点击即填入） */
const draft = defineModel<string>({ default: '' })

const chat = useChatStore()
const session = useSessionStore()
const settings = useSettingsStore()

onMounted(() => {
  if (!settings.loaded) void settings.load()
})

/* ---------- 纯文本模式一次性提示（UX §7.2）：首次生成时提示一次，不重复打扰 ---------- */
const TEXT_MODE_HINT_KEY = 'ai-dashboard.textModeHintShown'
const showTextModeHint = ref(false)
let textHintTimer: number | undefined

watch(
  () => session.runStatus,
  (s) => {
    if (s !== 'generating' || settings.isMultimodal || showTextModeHint.value) return
    try {
      if (localStorage.getItem(TEXT_MODE_HINT_KEY)) return
      localStorage.setItem(TEXT_MODE_HINT_KEY, '1')
    } catch {
      /* 本地存储不可用时每次会话最多提示一次 */
    }
    showTextModeHint.value = true
    textHintTimer = window.setTimeout(() => {
      showTextModeHint.value = false
    }, 10_000)
  }
)

function dismissTextModeHint(): void {
  showTextModeHint.value = false
  window.clearTimeout(textHintTimer)
}

onBeforeUnmount(() => window.clearTimeout(textHintTimer))

/* ---------- 发送快捷键提示 ---------- */
const sendShortcutHint = 'Enter 发送'

/* ---------- 附件（📎，仅多模态模式可用） ---------- */
const attachInput = ref<HTMLInputElement | null>(null)
/** 待发送的附件预览地址（本地图片的对象地址） */
const attachments = ref<string[]>([])

const canAttach = computed(() => settings.isMultimodal)
const attachTip = computed(() =>
  canAttach.value ? '添加图片或参考稿，也可以直接 Ctrl+V 粘贴' : '当前模型不支持图片，可在设置中更换模型'
)

function addImageFile(f: File): void {
  attachments.value.push(URL.createObjectURL(f))
}

function pickAttachment(): void {
  if (!canAttach.value) return
  attachInput.value?.click()
}

function onAttachmentPicked(e: Event): void {
  const files = (e.target as HTMLInputElement).files
  if (!files) return
  for (const f of Array.from(files)) {
    if (f.type.startsWith('image/')) addImageFile(f)
  }
  // 允许重复选同一张图
  ;(e.target as HTMLInputElement).value = ''
}

/* ---------- Ctrl+V / ⌘+V 粘贴图片 ---------- */
/** 纯文本模式下粘贴图片时的一句提示（3 秒自动消失） */
const pasteDeniedHint = ref(false)
let pasteHintTimer: number | undefined

function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length === 0) return // 纯文本粘贴走默认行为
  e.preventDefault() // 阻止把文件名/占位文本贴进输入框
  if (!canAttach.value) {
    pasteDeniedHint.value = true
    window.clearTimeout(pasteHintTimer)
    pasteHintTimer = window.setTimeout(() => (pasteDeniedHint.value = false), 3_000)
    return
  }
  for (const f of files) addImageFile(f)
}

function removeAttachment(i: number): void {
  const [url] = attachments.value.splice(i, 1)
  if (url) URL.revokeObjectURL(url)
}

function clearAttachments(): void {
  for (const url of attachments.value) URL.revokeObjectURL(url)
  attachments.value = []
}

onBeforeUnmount(() => {
  window.clearTimeout(pasteHintTimer)
  clearAttachments()
})

/* ---------- 输入框自动长高 ---------- */
const textarea = ref<HTMLTextAreaElement | null>(null)

async function autogrow(): Promise<void> {
  await nextTick()
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 144)}px` // 最多约 6 行
}

/* ---------- 发送（输入框永不锁定；允许只发图不打字） ---------- */
const canSend = computed(
  () => (draft.value.trim().length > 0 || attachments.value.length > 0) && !chat.sending
)

async function send(): Promise<void> {
  const text = draft.value.trim()
  if ((!text && attachments.value.length === 0) || chat.sending) return
  const files = attachments.value
  draft.value = ''
  attachments.value = []
  await autogrow()
  await chat.send(text, files)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return
  // Enter 发送（Ctrl/⌘+Enter 同效）；Shift+Enter 换行
  if (e.shiftKey) return
  e.preventDefault()
  void send()
}

defineExpose({ send })
</script>

<template>
  <div class="border-t border-line bg-card px-3 pb-3 pt-2">
    <!-- 纯文本模式一次性提示（首次生成时出现，可手动关掉，10 秒后自动消失） -->
    <div
      v-if="showTextModeHint"
      class="mb-2 flex items-center gap-2 rounded-control bg-status-attention-soft px-2.5 py-1.5 text-xs text-ink-secondary"
      role="status"
    >
      <span class="flex-1">当前为纯文本模式，布局检查使用结构化检测，不影响正常使用</span>
      <button
        type="button"
        class="shrink-0 rounded-control px-1.5 py-0.5 text-ink-faint hover:bg-card hover:text-ink"
        @click="dismissTextModeHint"
      >知道了</button>
    </div>

    <!-- 排队提示条：生成中发送后出现 -->
    <div
      v-if="queueHint"
      class="mb-2 flex items-center gap-1.5 rounded-control bg-primary-soft px-2.5 py-1.5 text-xs text-primary"
    >
      <span class="inline-block h-1.5 w-1.5 rounded-full bg-status-generating animate-pulse-blue" />
      已收到，将在当前步骤后处理
    </div>

    <!-- 纯文本模式下粘贴图片的提示（3 秒自动消失） -->
    <div
      v-if="pasteDeniedHint"
      class="mb-2 flex items-center gap-1.5 rounded-control bg-status-attention-soft px-2.5 py-1.5 text-xs text-ink-secondary"
      role="status"
    >
      当前模型不支持图片，可在设置中更换模型后再贴图
    </div>

    <!-- 待发送附件预览 -->
    <div v-if="attachments.length > 0" class="mb-2 flex flex-wrap gap-1.5">
      <div v-for="(url, i) in attachments" :key="i" class="relative">
        <img
          :src="url"
          alt="待发送的图片"
          class="h-12 w-12 rounded-control border border-line object-cover"
        />
        <button
          type="button"
          class="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-[10px] leading-none text-white"
          title="移除这张图片"
          @click="removeAttachment(i)"
        >
          <AppIcon name="close" :size="10" />
        </button>
      </div>
    </div>

    <!-- 输入框 -->
    <textarea
      ref="textarea"
      v-model="draft"
      rows="2"
      class="w-full resize-none rounded-control border border-line bg-page px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-primary"
      :placeholder="
        canAttach ? '描述你的想法，也可以直接粘贴图片…' : '描述你的想法，比如：把 CPU 图表放大一点…'
      "
      @input="autogrow"
      @keydown="onKeydown"
      @paste="onPaste"
    />

    <!-- 工具行：📎 🎤 + 快捷键提示 + 发送 -->
    <div class="mt-1.5 flex items-center gap-1">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-control text-base"
        :class="
          canAttach
            ? 'text-ink-secondary hover:bg-panel'
            : 'cursor-not-allowed text-ink-faint'
        "
        :title="attachTip"
        :aria-disabled="!canAttach"
        @click="pickAttachment"
      >
        <AppIcon name="attach-file" :size="18" />
      </button>
      <input
        ref="attachInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="onAttachmentPicked"
      />

      <button
        type="button"
        class="flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-control text-base text-ink-faint"
        title="语音输入还没开放，先打字告诉我吧"
        aria-disabled="true"
      >
        <AppIcon name="mic" :size="18" />
      </button>

      <span class="ml-1 hidden text-xs text-ink-faint sm:inline">
        {{ sendShortcutHint }}，Shift+Enter 换行{{ canAttach ? '，可粘贴图片' : '' }}
      </span>

      <button
        type="button"
        class="ml-auto rounded-control px-4 py-1.5 text-sm text-white transition-colors"
        :class="
          canSend
            ? 'bg-primary hover:bg-primary-hover active:bg-primary-active'
            : 'cursor-not-allowed bg-ink-faint'
        "
        :disabled="!canSend"
        @click="send"
      >
        发送
      </button>
    </div>
  </div>
</template>
