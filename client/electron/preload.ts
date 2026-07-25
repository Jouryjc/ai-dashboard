/**
 * Electron 预加载脚本：只暴露最少量平台信息，业务一律走 src/api 契约。
 */
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronApp', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? ''
  }
})
