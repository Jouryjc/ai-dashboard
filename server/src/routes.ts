/**
 * 路由 —— 实现 API_CONTRACT_HTTP.md 的全部 REST + SSE。
 * 全部 JSON；错误一律 { error: "大白话" }；probe 永不抛错（错误体现在 ProbeResult.ok=false）。
 */
import { Router, type Request, type Response } from 'express'
import * as orch from './orchestrator'
import { HttpError } from './orchestrator'
import { getOrCreateAdapter } from './loop-adapter/adapter'
import { store, type StoredEvent } from './store'
import { probe } from './gateway'
import { assertSafeId, checkMessageInput, createRateLimiter } from './security'
import type { ClarificationAnswer, ModelSettings, PreviewResolution, PublishConfig } from './wire'

export const router = Router()

/* ------------------------------ 工具 ------------------------------ */

// 消息接口限流：每个 IP 每分钟最多 20 条，防刷防失控连发（每次发消息都会真烧模型钱）
const messageRateLimit = createRateLimiter(20)

function wrap(handler: (req: Request, res: Response) => void | Promise<void>) {
  return (req: Request, res: Response): void => {
    // 注意：必须包一层 .then，否则 handler 同步抛错时会在参数求值阶段直接穿透，
    // 落到 Express 默认错误页（HTML + 堆栈），而不是契约要求的 { error: "大白话" }。
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message })
        } else {
          res.status(500).json({ error: '服务器出了点问题，请稍后再试' })
          // eslint-disable-next-line no-console
          console.error('[route error]', err)
        }
      })
  }
}

function writeEvent(res: Response, e: StoredEvent): void {
  res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`)
}

// 大屏名称上限：名字会进 JSON 持久化文件和各处 UI，太长纯属撑爆布局，没必要放行
const NAME_MAX_CHARS = 50
function checkDashboardName(name: string): void {
  if (name.length > NAME_MAX_CHARS) throw new HttpError(400, '名字太长了，最多 50 个字')
}

/* ------------------------------ 大屏 CRUD ------------------------------ */

router.get('/dashboards', (_req, res) => {
  res.json(orch.listDashboards())
})

router.post(
  '/dashboards',
  wrap((req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : ''
    checkDashboardName(name)
    res.json(orch.createDashboard(name))
  })
)

router.post(
  '/dashboards/:id/rename',
  wrap((req, res) => {
    const id = assertSafeId(req.params.id)
    const name = typeof req.body?.name === 'string' ? req.body.name : ''
    checkDashboardName(name)
    res.json(orch.renameDashboard(id, name))
  })
)

router.delete(
  '/dashboards/:id',
  wrap((req, res) => {
    orch.deleteDashboard(assertSafeId(req.params.id))
    res.status(204).end()
  })
)

router.post(
  '/dashboards/:id/cover',
  wrap((req, res) => {
    orch.uploadCover(assertSafeId(req.params.id), req.body?.image)
    res.status(204).end()
  })
)

/* ------------------------------ 工作台 ------------------------------ */

router.post(
  '/dashboards/:id/enter',
  wrap((req, res) => {
    res.json(orch.enterDashboard(assertSafeId(req.params.id)))
  })
)

router.post('/dashboards/:id/leave', (_req, res) => {
  // 契约：仅断开该客户端的 SSE，任务继续跑。
  // SSE 断开由客户端自己关连接实现；服务端任务本来就在后台跑，这里无需动作。
  res.status(204).end()
})

/* ------------------------------ 对话 ------------------------------ */

router.post(
  '/dashboards/:id/messages',
  wrap((req, res) => {
    const id = assertSafeId(req.params.id)
    // 限流放最前：连格式校验都不值得为刷量请求做
    if (!messageRateLimit(req.ip ?? 'unknown')) {
      res.status(429).json({ error: '你说得太快啦，歇一秒再发' })
      return
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    const attachments = Array.isArray(req.body?.attachments)
      ? (req.body.attachments as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    checkMessageInput(text, attachments)
    getOrCreateAdapter(id).handleMessage(text, attachments)
    res.status(202).end()
  })
)

router.post(
  '/dashboards/:id/messages/:messageId/answers',
  wrap((req, res) => {
    const id = assertSafeId(req.params.id)
    const messageId = assertSafeId(req.params.messageId)
    const answers = (Array.isArray(req.body?.answers) ? req.body.answers : []) as ClarificationAnswer[]
    getOrCreateAdapter(id).answerClarification(messageId, answers)
    res.status(202).end()
  })
)

router.post(
  '/dashboards/:id/options/:optionId',
  wrap((req, res) => {
    const id = assertSafeId(req.params.id)
    const optionId = assertSafeId(req.params.optionId)
    getOrCreateAdapter(id).chooseOption(optionId)
    res.status(202).end()
  })
)

router.post(
  '/dashboards/:id/auto-exec/cancel',
  wrap((req, res) => {
    orch.cancelAutoExec(assertSafeId(req.params.id))
    res.status(204).end()
  })
)

/* ------------------------------ 版本 ------------------------------ */

router.get(
  '/dashboards/:id/versions',
  wrap((req, res) => {
    res.json(orch.listVersions(assertSafeId(req.params.id)))
  })
)

router.get(
  '/dashboards/:id/versions/:versionId/export',
  wrap((req, res) => {
    const { filename, html } = orch.exportVersion(assertSafeId(req.params.id), assertSafeId(req.params.versionId))
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.status(200).send(html)
  })
)

router.post(
  '/dashboards/:id/versions/:versionId/preview',
  wrap((req, res) => {
    orch.previewVersion(assertSafeId(req.params.id), assertSafeId(req.params.versionId))
    res.status(204).end()
  })
)

router.post(
  '/dashboards/:id/versions/current',
  wrap((req, res) => {
    orch.backToCurrentVersion(assertSafeId(req.params.id))
    res.status(204).end()
  })
)

router.post(
  '/dashboards/:id/versions/:versionId/rollback',
  wrap((req, res) => {
    getOrCreateAdapter(assertSafeId(req.params.id)).rollback(assertSafeId(req.params.versionId))
    res.status(202).end()
  })
)

/* ------------------------------ 预览 ------------------------------ */

router.post(
  '/dashboards/:id/preview-resolution',
  wrap((req, res) => {
    const resolution = req.body?.resolution as PreviewResolution
    if (resolution !== '1920x1080' && resolution !== '2560x1440') {
      res.status(400).json({ error: 'resolution 只能是 1920x1080 或 2560x1440' })
      return
    }
    orch.setPreviewResolution(assertSafeId(req.params.id), resolution)
    res.status(204).end()
  })
)

/* ------------------------------ 发布 ------------------------------ */

router.post(
  '/dashboards/:id/publish',
  wrap((req, res) => {
    orch.handlePublish(assertSafeId(req.params.id))
    res.status(202).end()
  })
)

/* ------------------------------ 人工协助 ------------------------------ */

router.post(
  '/dashboards/:id/assist',
  wrap((req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined
    orch.startAssistFlow(assertSafeId(req.params.id), note)
    res.status(202).end()
  })
)

router.post(
  '/dashboards/:id/assist/end',
  wrap((req, res) => {
    orch.handleEndAssist(assertSafeId(req.params.id))
    res.status(202).end()
  })
)

/* ------------------------------ 设置与探测 ------------------------------ */

router.get('/settings', (_req, res) => {
  res.json(orch.getSettings())
})

router.put(
  '/settings',
  wrap((req, res) => {
    orch.saveSettings(req.body as ModelSettings)
    res.status(204).end()
  })
)

router.post(
  '/model-gateway/probe',
  wrap(async (req, res) => {
    // 真实探测，永远不抛错：错误体现在 ProbeResult.ok=false
    // 注意要用 resolveProbeSettings：getSettings() 返回的是脱敏 Key，直接探测必失败；
    // 客户端传了表单时也要把表单里的脱敏回传值还原成原文
    const settings = orch.resolveProbeSettings(req.body?.settings as ModelSettings | undefined)
    const result = await probe(settings).catch((err) => ({
      ok: false,
      supportsVision: false,
      message: '连不上：出了点意外情况',
      detail: err instanceof Error ? err.message : String(err)
    }))
    res.json(result)
  })
)

/* ------------------------------ 发布配置 ------------------------------ */

router.get('/publish-config', (_req, res) => {
  res.json(orch.getPublishConfig())
})

router.put(
  '/publish-config',
  wrap((req, res) => {
    orch.savePublishConfig(req.body as PublishConfig)
    res.status(204).end()
  })
)

/* ------------------------------ 数据源 ------------------------------ */

router.get('/data-sources', (_req, res) => {
  res.json(orch.getDataSources())
})

router.put(
  '/data-sources',
  wrap((req, res) => {
    if (!Array.isArray(req.body)) throw new HttpError(400, '数据源列表格式不对')
    res.json(orch.saveDataSources(req.body))
  })
)

router.post(
  '/data-sources/probe',
  wrap(async (req, res) => {
    // 真实探测，永远不抛错：错误体现在 DataSourceProbeResult.ok=false
    const source = req.body?.source && typeof req.body.source === 'object' ? req.body.source : req.body
    res.json(await orch.probeDataSource(source))
  })
)

/* ------------------------------ SSE ------------------------------ */

router.get('/dashboards/:id/events', (req, res) => {
  // SSE 走长连接不走 wrap()，路径校验的 HttpError 要自己接住转成 JSON
  let dashId: string
  try {
    dashId = assertSafeId(req.params.id)
  } catch {
    res.status(400).json({ error: '请求参数不对' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 3000\n\n')

  // Last-Event-ID 补发缺失事件再续流（EventSource 自动携带）
  const lastSeq = Number.parseInt(req.header('Last-Event-ID') ?? '', 10)
  if (Number.isFinite(lastSeq) && lastSeq > 0) {
    for (const e of store.eventsSince(dashId, lastSeq)) writeEvent(res, e)
  }

  const unsubscribe = store.subscribe(dashId, (e) => writeEvent(res, e))
  // 心跳：每 15s 一行 ": ping"
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})
