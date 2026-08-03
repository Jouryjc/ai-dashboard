<script setup lang="ts">
/**
 * 中区 · 大屏预览区（UX §4.2 中区）。
 * - 数据大屏与业务应用都按各自逻辑分辨率等比缩放。
 * - 三种状态（强制）：
 *   empty    无任何版本 → 占位引导「在左侧描述你想要的大屏」
 *   building 构建中 → 旧版本不清空 + 半透明遮罩「正在生成新版本…」
 *   ready    就绪 → 新版本淡入 + 右上角短暂「已更新 ✓」
 * - 预览内容用 <iframe> 加载 session.previewUrl（public/preview/ 下的 mock 产物）。
 * 数据源：useSessionStore（previewState / previewUrl / resolution / setResolution）。
 */
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { useSessionStore } from '../../stores/session'
import type { PreviewResolution } from '../../types'
import { RESOLUTION_LABEL, useScaleFit } from './useScaleFit'
import AppIcon from '../common/AppIcon.vue'

const session = useSessionStore()
const { containerRef, frameStyle } = useScaleFit(toRef(session, 'resolution'))

/* ---------- ⟳ 刷新：强制重载 iframe ---------- */
const refreshKey = ref(0)
function refresh(): void {
  refreshKey.value += 1
}

/* ---------- 分辨率切换器 ---------- */
const resMenuOpen = ref(false)
const resolutions = computed<PreviewResolution[]>(() =>
  session.artifactKind === 'business-app'
    ? ['1920x1080', '1366x768']
    : ['1920x1080', '2560x1440']
)
async function pickResolution(r: PreviewResolution): Promise<void> {
  resMenuOpen.value = false
  await session.setResolution(r)
}

/* ---------- 「已更新 ✓」toast：新版本淡入时右上角短暂浮现 ---------- */
const showUpdatedToast = ref(false)
let toastTimer: number | undefined
let seenInitialUrl = false
watch(
  () => session.previewUrl,
  (url) => {
    if (!url) return
    // 实时生成中的局部刷新不算"更新"，不弹 toast
    if (session.previewBuildingLive) return
    // 刚进工作台时的首个地址不算"更新"，不弹 toast
    if (!seenInitialUrl) {
      seenInitialUrl = true
      return
    }
    showUpdatedToast.value = true
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      showUpdatedToast.value = false
    }, 2600)
  }
)
onBeforeUnmount(() => window.clearTimeout(toastTimer))
</script>

<template>
  <section
    class="relative flex h-full min-h-0 flex-col bg-page"
    :aria-label="session.artifactKind === 'business-app' ? '业务应用预览区' : '大屏预览区'"
  >
    <!-- 预览画布区 -->
    <div ref="containerRef" class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
      <!-- 状态三：无任何版本 → 占位引导 -->
      <div
        v-if="session.previewState === 'empty'"
        class="flex h-full w-full flex-col items-center justify-center gap-4 rounded-card border border-dashed border-line-strong bg-card text-center"
      >
        <!-- 简单插画：一个大屏轮廓 -->
        <svg width="120" height="84" viewBox="0 0 120 84" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="112" height="64" rx="6" class="fill-primary-soft" />
          <rect x="4" y="4" width="112" height="64" rx="6" class="stroke-primary-border" stroke-width="2" />
          <rect x="14" y="16" width="40" height="8" rx="2" class="fill-primary-border" />
          <rect x="14" y="32" width="28" height="24" rx="3" class="fill-primary-border" />
          <rect x="48" y="32" width="28" height="24" rx="3" class="fill-primary-border" />
          <rect x="82" y="32" width="24" height="24" rx="3" class="fill-primary-border" />
          <rect x="52" y="72" width="16" height="4" rx="2" class="fill-line-strong" />
        </svg>
        <div>
          <p class="text-base font-medium text-ink">
            在左侧描述你想要的{{ session.artifactKind === 'business-app' ? '业务应用' : '大屏' }}
          </p>
          <p class="mt-1 text-sm text-ink-faint">
            {{ session.artifactKind === 'business-app' ? '描述列表、详情、表单或业务操作，做好后会显示在这里' : '说句话就行，做好后会显示在这里' }}
          </p>
        </div>
      </div>

      <!-- 状态一/二：有版本 → 等比缩放的逻辑画布 -->
      <div
        v-else-if="session.previewUrl"
        :style="frameStyle"
        class="shrink-0 overflow-hidden rounded-card bg-ink shadow-card"
      >
        <!-- key 含地址与刷新计数：换版本 / 点刷新都会重载；fade 过渡实现淡入 -->
        <Transition name="preview-fade" mode="out-in">
          <iframe
            :key="`${session.previewUrl}#${refreshKey}`"
            :src="session.previewUrl"
            :title="session.artifactKind === 'business-app' ? '业务应用预览' : '大屏预览'"
            class="block h-full w-full border-0 bg-ink"
            sandbox="allow-scripts allow-same-origin"
          />
        </Transition>
      </div>

      <!-- 状态一：构建中遮罩（旧版本不清空，盖半透明层；实时生成模式不盖，改显进度细条） -->
      <div
        v-if="session.previewState === 'building' && !session.previewBuildingLive"
        class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-ink/50"
        role="status"
      >
        <span
          class="block h-10 w-10 animate-spin rounded-full border-[3px] border-white/30 border-t-white"
          aria-hidden="true"
        ></span>
        <p class="text-base font-medium text-white">正在生成新版本…</p>
        <p class="text-sm text-white/70">旧版本还能看，做好后会自动换成新的</p>
      </div>

      <!-- 实时生成中：顶部细进度条（页面正在下面逐步长出来） -->
      <div
        v-if="session.previewState === 'building' && session.previewBuildingLive"
        class="absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-ink/60 px-4 py-2 backdrop-blur-sm"
        role="status"
      >
        <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-status-generating animate-pulse-blue" />
        <p class="text-xs text-white/90">正在实时生成，页面会逐步长出来…</p>
      </div>

      <!-- 就绪提示：右上角短暂「已更新 ✓」 -->
      <Transition name="toast-fade">
        <div
          v-if="showUpdatedToast"
          class="absolute right-4 top-16 z-20 flex items-center gap-1.5 rounded-card bg-card px-3 py-2 text-sm text-ink shadow-pop"
          role="status"
        >
          <AppIcon name="check-circle" :size="16" class="text-status-done" /> 已更新
        </div>
      </Transition>

      <!-- 工具条：分辨率切换 + 刷新（预览区顶部居中的浮动工具条，还原 workbench 高保真稿） -->
      <div class="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-card border border-line bg-card p-1 shadow-card">
        <div class="relative">
          <button
            type="button"
            class="flex h-7 items-center gap-1 rounded-control px-2 text-xs text-ink-secondary hover:bg-panel hover:text-ink"
            :aria-expanded="resMenuOpen"
            aria-label="切换预览分辨率"
            @click="resMenuOpen = !resMenuOpen"
          >
            {{ RESOLUTION_LABEL[session.resolution] }}
            <AppIcon name="expand-more" :size="12" />
          </button>
          <!-- 点击空白处收起 -->
          <button
            v-if="resMenuOpen"
            type="button"
            class="fixed inset-0 z-10 cursor-default"
            aria-label="收起分辨率菜单"
            @click="resMenuOpen = false"
          ></button>
          <ul
            v-if="resMenuOpen"
            class="absolute left-1/2 z-20 mt-1 w-36 -translate-x-1/2 overflow-hidden rounded-card border border-line bg-card py-1 shadow-pop"
          >
            <li v-for="r in resolutions" :key="r">
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-primary-soft"
                :class="r === session.resolution ? 'font-medium text-primary' : 'text-ink'"
                @click="pickResolution(r)"
              >
                {{ RESOLUTION_LABEL[r] }}
                <AppIcon v-if="r === session.resolution" name="check" :size="14" />
              </button>
            </li>
          </ul>
        </div>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-control text-sm text-ink-secondary hover:bg-panel hover:text-ink"
          title="刷新预览"
          aria-label="刷新预览"
          @click="refresh"
        >
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 新版本淡入替换 */
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.35s ease;
}
.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}
/* 「已更新 ✓」浮现 */
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
