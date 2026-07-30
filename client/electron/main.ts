/**
 * Electron 主进程入口
 * 窗口规格见 UX 文档 §8：默认 1440×900，最小 1200×720，原生标题栏。
 * 'capture-url' 通道：离屏截取预览页 1920×1080 PNG（封面自动更新用），失败返回 null。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
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

/* ---------- 打开外部链接（发布后的公网大屏地址）：用系统默认浏览器 ---------- */
ipcMain.handle('open-external', (_event, url: unknown): Promise<void> => {
  if (typeof url !== 'string' || !url) return Promise.resolve()
  // 只允许 http(s)，避免任意协议被打开
  if (!/^https?:\/\//i.test(url)) return Promise.resolve()
  return shell.openExternal(url)
})

/* ---------- 离屏截图（封面自动更新）：不可见窗口截 1920×1080 PNG ---------- */
/** 页面加载上限：超时按失败处理（返回 null），否则隐藏窗口和 IPC 句柄会永久泄漏 */
const CAPTURE_LOAD_TIMEOUT_MS = 30_000
ipcMain.handle('capture-url', async (_event, url: unknown): Promise<string | null> => {
  if (typeof url !== 'string' || !url) return null
  let win: BrowserWindow | null = null
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      // 宽高按内容区算，保证截出来正好 1920×1080
      useContentSize: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    await Promise.race([
      win.loadURL(url),
      new Promise<never>((_resolve, reject) => {
        loadTimer = setTimeout(() => reject(new Error('页面加载超时')), CAPTURE_LOAD_TIMEOUT_MS)
      })
    ])
    // 等图表动画/字体稳定一下再截
    await new Promise((resolve) => setTimeout(resolve, 800))
    if (win.isDestroyed()) return null
    const image = await win.webContents.capturePage()
    return `data:image/png;base64,${image.toPNG().toString('base64')}`
  } catch {
    return null
  } finally {
    if (loadTimer) clearTimeout(loadTimer)
    if (win && !win.isDestroyed()) win.destroy()
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

