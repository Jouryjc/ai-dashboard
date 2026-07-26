/**
 * Electron 预加载脚本：只暴露最少量平台信息与离屏截图能力，业务一律走 src/api 契约。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronApp', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? ''
  },
  /**
   * 离屏截取指定 URL 的 1920×1080 页面（主进程 'capture-url' 通道）。
   * 返回 PNG dataURL；失败（加载出错/超时等）返回 null。
   */
  captureUrl: (url: string): Promise<string | null> =>
    ipcRenderer.invoke('capture-url', url) as Promise<string | null>
})
