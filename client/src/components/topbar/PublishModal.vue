<script setup lang="ts">
/**
 * 发布弹窗 —— 全流程托管发布到 AiLab CodeBox。
 * 由 publishProgress 事件独占驱动，分四个阶段视图：
 *   idle     确认页（截图 + 摘要 + 开始发布）
 *   uploading/serving  进度页（步骤指示 + 实时文案 + loading 动画）
 *   success  成功页（✓ + 公网地址 + 打开预览 + 完成）
 *   failed   失败页（原因 + 重试 + 关闭）
 *
 * 发布期间信息只在弹窗内显示，不进对话区/右栏（服务端走 publishProgress 专用事件）。
 * 发布成功后顶栏另有一个常驻「打开预览」按钮（PublishModal 关闭后仍可用）。
 * 点击「开始发布」后乐观切到 uploading（不等 POST 返回），避免 UI 卡顿。
 */
import { computed, onBeforeUnmount } from 'vue'
import { useSessionStore } from '../../stores/session'
import { openExternal } from '../../utils/open-external'
import AppIcon from '../common/AppIcon.vue'

const emit = defineEmits<{ close: [] }>()

const session = useSessionStore()

/** 当前版本（确认页展示截图 + 摘要） */
const currentVersion = computed(() => session.versions.find((v) => v.isCurrent) ?? null)
/** 当前阶段（从 session.publishPhase 派生，方便模板分支） */
const phase = computed(() => session.publishPhase)
/** 发布中（uploading/serving）禁止关闭，避免中断后状态丢失 */
const inProgress = computed(() => phase.value === 'uploading' || phase.value === 'serving')

/* ---------- 开始发布 / 重试（不 await：publish 乐观切 phase，POST fire-and-forget） ---------- */
function startPublish(): void {
  session.publish()
}

/* ---------- 关闭弹窗（仅非发布中可关） ---------- */
function requestClose(): void {
  if (!inProgress.value) emit('close')
}

/* ---------- Esc 关闭（仅非发布中生效） ---------- */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !inProgress.value) emit('close')
}
window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/* ---------- 进度步骤指示（uploading → serving 两步） ---------- */
const steps = [
  { key: 'upload', label: '上传大屏到云端', hint: '准备环境、传文件' },
  { key: 'serve', label: '发布到公网', hint: '启动服务、生成地址' }
] as const
function stepState(key: 'upload' | 'serve'): 'done' | 'active' | 'pending' {
  const ph = phase.value
  if (ph === 'success') return 'done'
  if (key === 'upload') {
    return ph === 'uploading' ? 'active' : ph === 'serving' || ph === 'failed' ? 'done' : 'pending'
  }
  return ph === 'serving' ? 'active' : ph === 'failed' ? 'pending' : 'pending'
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="发布大屏"
      @click.self="requestClose"
    >
      <div class="w-[26rem] overflow-hidden rounded-card bg-card shadow-pop">
        <!-- ============ 顶部色条（按阶段变色，提供视觉锚点） ============ -->
        <div
          class="h-1.5 w-full"
          :class="{
            'bg-primary': phase === 'idle' || inProgress,
            'bg-status-done': phase === 'success',
            'bg-danger': phase === 'failed'
          }"
        />

        <div class="p-6">
          <!-- ============ 确认页（idle） ============ -->
          <template v-if="phase === 'idle'">
            <div class="flex items-center gap-3">
              <span class="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                <AppIcon name="publish" :size="18" />
              </span>
              <div>
                <p class="text-sm font-semibold text-ink">发布这版大屏？</p>
                <p class="text-xs text-ink-faint">传到云端，生成公网地址，别人就能直接打开看</p>
              </div>
            </div>

            <img
              v-if="currentVersion?.screenshotUrl"
              :src="currentVersion.screenshotUrl"
              alt="当前版本截图"
              class="mt-4 aspect-video w-full rounded-control border border-line object-cover shadow-sm"
            />

            <div class="mt-4 grid grid-cols-[4.5rem_1fr] gap-y-1.5 text-xs">
              <span class="text-ink-faint">大屏</span>
              <span class="truncate text-ink">「{{ session.dashboardName }}」{{ currentVersion?.label ?? '' }}</span>
              <span class="text-ink-faint">本次改动</span>
              <span class="text-ink-secondary">{{ currentVersion?.summary || '无说明' }}</span>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <button
                type="button"
                class="rounded-control border border-line px-4 py-2 text-sm text-ink-secondary hover:bg-panel"
                @click="emit('close')"
              >
                再想想
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover active:bg-primary-active"
                @click="startPublish"
              >
                <AppIcon name="publish" :size="14" />
                开始发布
              </button>
            </div>
          </template>

          <!-- ============ 进度页（uploading / serving） ============ -->
          <template v-else-if="inProgress">
            <div class="flex items-center gap-3">
              <span class="relative flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft">
                <AppIcon name="publish" :size="18" class="text-primary" />
                <span class="absolute inset-0 animate-ping rounded-full bg-primary/30"></span>
              </span>
              <div>
                <p class="text-sm font-semibold text-ink">正在发布到云端</p>
                <p class="text-xs text-ink-faint">通常一两分钟，发布期间请勿关闭</p>
              </div>
            </div>

            <!-- 步骤指示 -->
            <div class="mt-5 space-y-1">
              <div
                v-for="(s, i) in steps"
                :key="s.key"
                class="flex items-start gap-3 rounded-control px-2 py-2 transition-colors"
                :class="stepState(s.key) === 'active' ? 'bg-primary-soft/60' : ''"
              >
                <span
                  class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs transition-colors"
                  :class="{
                    'bg-status-done text-white': stepState(s.key) === 'done',
                    'bg-primary text-white': stepState(s.key) === 'active',
                    'border border-line bg-card text-ink-faint': stepState(s.key) === 'pending'
                  }"
                >
                  <AppIcon
                    v-if="stepState(s.key) === 'done'"
                    name="check"
                    :size="13"
                  />
                  <span
                    v-else-if="stepState(s.key) === 'active'"
                    class="h-2 w-2 animate-pulse rounded-full bg-white"
                  />
                  <span v-else>{{ i + 1 }}</span>
                </span>
                <div class="min-w-0">
                  <p
                    class="text-sm leading-tight"
                    :class="stepState(s.key) === 'pending' ? 'text-ink-faint' : 'text-ink'"
                  >
                    {{ s.label }}
                  </p>
                  <p v-if="stepState(s.key) === 'active'" class="mt-0.5 truncate text-xs text-ink-secondary">
                    {{ session.publishMessage }}
                  </p>
                </div>
              </div>
            </div>
          </template>

          <!-- ============ 成功页（success） ============ -->
          <template v-else-if="phase === 'success'">
            <div class="flex flex-col items-center text-center">
              <span class="flex h-12 w-12 items-center justify-center rounded-full bg-status-done/15">
                <AppIcon name="check-circle" :size="28" class="text-status-done" />
              </span>
              <p class="mt-3 text-sm font-semibold text-ink">大屏已发布 🎉</p>
              <p class="mt-1 text-xs text-ink-secondary">
                公网地址已生成，点下面按钮在浏览器打开，或复制地址分享
              </p>
            </div>

            <div class="mt-4 flex items-center gap-2 rounded-control border border-line bg-panel px-3 py-2.5">
              <AppIcon name="open-in-new" :size="14" class="shrink-0 text-ink-faint" />
              <span class="min-w-0 flex-1 truncate text-xs text-ink">{{ session.publishUrl }}</span>
              <button
                v-if="session.publishUrl"
                type="button"
                class="flex shrink-0 items-center gap-1 rounded-control bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                @click="session.publishUrl && openExternal(session.publishUrl)"
              >
                打开预览
              </button>
            </div>

            <div class="mt-5 flex justify-end">
              <button
                type="button"
                class="rounded-control border border-line px-4 py-2 text-sm text-ink-secondary hover:bg-panel"
                @click="emit('close')"
              >
                完成
              </button>
            </div>
          </template>

          <!-- ============ 失败页（failed） ============ -->
          <template v-else-if="phase === 'failed'">
            <div class="flex flex-col items-center text-center">
              <span class="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
                <AppIcon name="error" :size="28" class="text-danger" />
              </span>
              <p class="mt-3 text-sm font-semibold text-ink">发布没有成功</p>
            </div>

            <div class="mt-4 max-h-28 overflow-auto rounded-control border border-danger/40 bg-danger/5 px-3 py-2.5">
              <p class="whitespace-pre-wrap break-all text-xs leading-5 text-ink">
                {{ session.publishError || '发布过程中出了点问题' }}
              </p>
            </div>

            <p class="mt-3 text-xs leading-5 text-ink-secondary">
              大屏内容都还在，可以稍后再试。如果是凭据问题，先到「设置 · 发布配置」检查。
            </p>

            <div class="mt-5 flex justify-end gap-2">
              <button
                type="button"
                class="rounded-control border border-line px-4 py-2 text-sm text-ink-secondary hover:bg-panel"
                @click="emit('close')"
              >
                关闭
              </button>
              <button
                type="button"
                class="rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
                @click="startPublish"
              >
                重新发布
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
