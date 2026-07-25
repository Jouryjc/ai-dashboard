/// <reference types="vite/client" />

/** preload 暴露的最小平台信息（electron/preload.ts） */
interface Window {
  electronApp?: {
    platform: string
    versions: { electron: string; chrome: string }
  }
}
