/**
 * 打开一个外部 http(s) 链接（用系统默认浏览器）。
 *
 * Electron 下走 preload 暴露的 'open-external' 通道（主进程 shell.openExternal，仅放行 http(s)）；
 * 浏览器 dev 模式下（electronApp 不存在）兜底用 window.open 新标签页打开。
 * 用于发布后让用户在浏览器里查看公网大屏地址。
 */
export async function openExternal(url: string): Promise<void> {
  const bridge = window.electronApp?.openExternal
  if (typeof bridge === 'function') {
    await bridge(url)
    return
  }
  // 浏览器 dev 兜底
  window.open(url, '_blank', 'noopener')
}
