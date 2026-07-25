/**
 * 预览等比缩放（中区预览区 + 全屏演示模式共用）。
 * 逻辑分辨率固定（1920×1080 / 2560×1440），用 CSS transform scale 适配容器：
 * 缩放只影响眼睛看到的画面，不影响截图与视觉验证的 1920×1080 基准（UX §4.2 / §7.4）。
 *
 * 用法：
 *   const { containerRef, frameStyle } = useScaleFit(toRef(session, 'resolution'))
 *   <div ref="containerRef" class="flex items-center justify-center overflow-hidden">
 *     <div :style="frameStyle" class="shrink-0"><iframe class="h-full w-full" /></div>
 *   </div>
 */
import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties, type Ref } from 'vue'
import type { PreviewResolution } from '../../types'

/** 各分辨率的逻辑画布尺寸 */
export const LOGICAL_SIZE: Record<PreviewResolution, { w: number; h: number }> = {
  '1920x1080': { w: 1920, h: 1080 },
  '2560x1440': { w: 2560, h: 1440 }
}

/** 分辨率切换器的展示文案 */
export const RESOLUTION_LABEL: Record<PreviewResolution, string> = {
  '1920x1080': '1920 × 1080',
  '2560x1440': '2560 × 1440'
}

export function useScaleFit(resolution: Ref<PreviewResolution>): {
  containerRef: Ref<HTMLElement | null>
  logical: Ref<{ w: number; h: number }>
  scale: Ref<number>
  frameStyle: Ref<CSSProperties>
} {
  /** 外层容器（需要相对定位/满尺寸，内部居中） */
  const containerRef = ref<HTMLElement | null>(null)
  const box = ref({ w: 0, h: 0 })

  let ro: ResizeObserver | null = null
  onMounted(() => {
    if (!containerRef.value) return
    ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) box.value = { w: r.width, h: r.height }
    })
    ro.observe(containerRef.value)
  })
  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
  })

  const logical = computed(() => LOGICAL_SIZE[resolution.value])
  const scale = computed(() => {
    const { w, h } = box.value
    if (w <= 0 || h <= 0) return 0
    return Math.min(w / logical.value.w, h / logical.value.h)
  })
  /** 逻辑画布：固定 w×h，整体缩放，中心为变换原点（配合外层 flex 居中） */
  const frameStyle = computed<CSSProperties>(() => ({
    width: `${logical.value.w}px`,
    height: `${logical.value.h}px`,
    transform: `scale(${scale.value})`,
    transformOrigin: 'center center'
  }))

  return { containerRef, logical, scale, frameStyle }
}
