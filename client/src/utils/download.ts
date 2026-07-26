/**
 * 浏览器内下载工具：fetch 拉取内容 → Blob → 临时 a[download] 点击保存。
 * 用于「导出代码」（导出某版本的完整 HTML）。
 */

/** 文件名清洗：去掉各平台不允许的字符，空名兜底 */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || '未命名大屏'
}

/** 拉取 url 的文本内容并以 filename 存为本地文件；失败抛错（调用方自行处理） */
export async function fetchTextAsDownload(url: string, filename: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败（${res.status}）`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收，避免点击还没触发下载就释放
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
