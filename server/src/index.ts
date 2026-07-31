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
import { createPreviewApp, PREVIEW_HOST, PREVIEW_ORIGIN, PREVIEW_PORT } from './preview'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST?.trim() || '127.0.0.1'
const allowedOrigins = new Set(
  (process.env.APP_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,null')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
)

const app = express()
app.disable('x-powered-by')

/* CORS：只允许桌面客户端与本地开发地址读取本机 API。 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header('Origin')
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID, X-AI-Dashboard-Client')
  if (req.method === 'OPTIONS') {
    if (origin && !allowedOrigins.has(origin)) res.status(403).end()
    else res.status(204).end()
    return
  }
  next()
})

// dataURL 图片附件可能较大
app.use(express.json({ limit: '30mb' }))

/* 旧预览地址兼容：只做跳转，生成代码始终在独立 origin 执行。 */
app.use('/preview', (req, res) => {
  res.redirect(307, `${PREVIEW_ORIGIN}/preview${req.url}`)
})
app.use('/covers', express.static(dirs.covers))
app.use('/shots', express.static(dirs.shots))
// 模板库（布局/组件 demo 图），启动时从 client/templates 同步
app.use('/templates', express.static(path.join(dirs.root, 'templates')))

/* API：写操作要求客户端标记，阻断跨站表单静默操作本机服务。 */
app.use('/api/v1', (req, res, next) => {
  if (req.method !== 'GET' && req.header('X-AI-Dashboard-Client') !== '1') {
    res.status(403).json({ error: '请求来源无法确认，请从客户端重新操作' })
    return
  }
  next()
})
app.use('/api/v1', router)

app.get('/healthz', (_req, res) => res.json({ ok: true, previewOrigin: PREVIEW_ORIGIN }))

// 恢复数据（种入示例大屏 + 从 jsonl 恢复事件 seq）
boot()

createPreviewApp().listen(PREVIEW_PORT, PREVIEW_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`隔离预览服务已启动: ${PREVIEW_ORIGIN}`)
})

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`AI 大屏工作台服务端已启动: http://${HOST}:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`数据目录: ${path.resolve(dirs.root)}`)
})
