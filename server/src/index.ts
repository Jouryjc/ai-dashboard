/**
 * 服务端入口：Express 应用装配 + 启动。
 * 端口 8787（PORT 可覆盖）；CORS 手写中间件（Allow-Origin: *，处理 OPTIONS）；
 * 静态托管 /preview（构建产物）与 /covers（大屏封面）。
 */
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { router } from './routes'
import { boot } from './orchestrator'
import { dirs } from './store'

const PORT = Number(process.env.PORT ?? 8787)

// CORS 白名单：ALLOWED_ORIGINS 环境变量逗号分隔；未设置时保持 *（本地演示形态不变）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const app = express()

/* 全局安全响应头：禁止浏览器瞎猜内容类型（防把 HTML 当脚本执行等嗅探攻击） */
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
})

/* CORS：默认全放开（手写，不引依赖）；设了 ALLOWED_ORIGINS 就只放行名单内的来源 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header('Origin')
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    // 响应随来源而变，必须告诉缓存层按 Origin 区分
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

// dataURL 图片附件可能较大
app.use(express.json({ limit: '30mb' }))

/* 静态托管的安全响应头：
 * CSP 只允许自身 + 内联（大屏产物是自包含单文件，内联脚本样式是正常形态）+ data/blob（图表 canvas、截图）；
 * X-Frame-Options 挡住别人的站点把我们嵌进 iframe（点击劫持），客户端 iframe 预览是同源不受 SAMEORIGIN 影响。 */
function staticSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self' data: blob:")
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  next()
}

/* 静态：构建产物预览 + 封面 + 修复前后对比截图 */
app.use('/preview', staticSecurityHeaders, express.static(dirs.previews, { index: 'index.html' }))
app.use('/covers', staticSecurityHeaders, express.static(dirs.covers))
app.use('/shots', staticSecurityHeaders, express.static(dirs.shots))
// 模板库（布局/组件 demo 图），启动时从 client/templates 同步
app.use('/templates', staticSecurityHeaders, express.static(path.join(dirs.root, 'templates')))

/* API */
app.use('/api/v1', router)

app.get('/healthz', (_req, res) => res.json({ ok: true }))

// 恢复数据（种入示例大屏 + 从 jsonl 恢复事件 seq）
boot()

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`AI 大屏工作台服务端已启动: http://localhost:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`数据目录: ${path.resolve(dirs.root)}`)
})
