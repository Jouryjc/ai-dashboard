/// <reference types="vite/client" />

/** preload 暴露的最小平台信息与离屏截图能力（electron/preload.ts） */
interface Window {
  electronApp?: {
    platform: string
    versions: { electron: string; chrome: string }
    /**
     * 离屏截取指定 URL 的 1920×1080 页面，返回 PNG dataURL；失败返回 null。
     * 仅 Electron 环境有；浏览器 dev 模式下为 undefined（封面截图逻辑静默跳过）。
     */
    captureUrl?: (url: string) => Promise<string | null>
    /**
     * 用系统默认浏览器打开一个 http(s) 外链（发布后打开公网大屏地址用）。
     * 仅 Electron 环境有；浏览器 dev 模式下为 undefined（调用方需兜底 window.open）。
     */
    openExternal?: (url: string) => Promise<void>
  }
}
