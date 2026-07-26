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

const app = express()

/* CORS：开发期全放开（手写，不引依赖） */
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
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

/* 静态：构建产物预览 + 封面 + 修复前后对比截图 */
app.use('/preview', express.static(dirs.previews, { index: 'index.html' }))
app.use('/covers', express.static(dirs.covers))
app.use('/shots', express.static(dirs.shots))
// 模板库（布局/组件 demo 图），启动时从 client/templates 同步
app.use('/templates', express.static(path.join(dirs.root, 'templates')))

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
