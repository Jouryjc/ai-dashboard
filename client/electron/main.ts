/**
 * Electron 主进程入口
 * 窗口规格见 UX 文档 §8：默认 1440×900，最小 1200×720，原生标题栏。
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

const devServerUrl = process.env.VITE_DEV_SERVER_URL

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 720,
    title: 'AI 大屏工作台',
    backgroundColor: '#F5F6FA',
    // 原生标题栏（UX §8 / C13），不做 frame: false
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
