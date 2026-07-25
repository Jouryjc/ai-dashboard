#!/usr/bin/env node
/**
 * smoke.mjs —— 端到端冒烟（可重复执行）：npm run smoke
 *
 * 步骤：
 *   1. 启动 stub LLM（9100）+ 服务端（8787，独立数据目录 data-smoke，先清空）
 *   2. PUT settings 指向 stub → POST probe 返回 ok 且支持看图
 *   3. POST 建大屏 → 发消息（带参考图）→ 订阅 SSE 看 message/stage/blocker 流出
 *   4. 回答澄清 → 等 previewReady → GET 预览 HTML 200 且无外部引用
 *   5. 再发一条不带图的修改消息 → 等 v2 previewReady
 *   6. rollback → 新节点；publish → 5 秒后已发布
 *   7. Last-Event-ID 补发抽查
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_DIR, 'data-smoke')
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 取一个空闲端口（避免与正在运行的 dev server / 上次残留进程冲突，保证可重复执行） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

let BASE = ''
let STUB_PORT = 0

let passed = 0
function ok(name, extra = '') {
  passed += 1
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`)
}
function fail(name, extra = '') {
  console.error(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`)
  throw new Error(`smoke failed: ${name}`)
}

/* ---------- 子进程 ---------- */
const children = []
function startProc(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  p.stdout.on('data', (d) => process.env.VERBOSE && console.log(`[${name}] ${d}`.trimEnd()))
  p.stderr.on('data', (d) => process.env.VERBOSE && console.error(`[${name}!] ${d}`.trimEnd()))
  children.push(p)
  return p
}
function cleanup() {
  for (const p of children) {
    try { p.kill('SIGKILL') } catch { /* 已退出 */ }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

/* ---------- HTTP 工具 ---------- */
async function api(method, p, body) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 120))
  }
}

/* ---------- SSE 订阅 ---------- */
function openSse(dashId, headers = {}) {
  const events = []
  const controller = new AbortController()
  fetch(`${BASE}/api/v1/dashboards/${dashId}/events`, { headers, signal: controller.signal })
    .then(async (res) => {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          let id = null, event = null, data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) id = line.slice(3).trim()
            else if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (event) events.push({ id: Number(id), event, data: data ? JSON.parse(data) : null })
        }
      }
    })
    .catch(() => { /* 主动断开 */ })
  return {
    events,
    close: () => controller.abort(),
    async waitFor(event, pred, timeoutMs, what) {
      return waitFor(
        () => events.find((e) => e.event === event && (!pred || pred(e))),
        timeoutMs,
        what ?? `SSE 事件 ${event}`
      )
    }
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log('== 冒烟开始 ==')
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  STUB_PORT = Number(process.env.STUB_PORT ?? (await freePort()))
  const serverPort = Number(process.env.SMOKE_PORT ?? (await freePort()))
  BASE = `http://127.0.0.1:${serverPort}`

  startProc('stub', process.execPath, [path.join(SERVER_DIR, 'scripts/stub-llm.mjs'), String(STUB_PORT)])
  const tsxBin = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx')
  startProc('server', tsxBin, [path.join(SERVER_DIR, 'src/index.ts')], {
    PORT: String(serverPort),
    DATA_DIR
  })

  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 30_000, '服务端启动')
  ok(`stub(${STUB_PORT}) + 服务端(${serverPort}) 已启动`)

  // 1. settings → probe
  const put = await api('PUT', '/settings', {
    provider: '冒烟测试',
    apiBase: `http://127.0.0.1:${STUB_PORT}/v1`,
    apiKey: 'sk-smoke',
    model: 'stub-1',
    plannerModel: '',
    coderModel: '',
    visionModel: ''
  })
  if (put.status !== 204) fail('PUT /settings', `HTTP ${put.status}`)
  const probe = await api('POST', '/model-gateway/probe', {
    settings: (await api('GET', '/settings')).json
  })
  if (!probe.json?.ok) fail('probe 连通', JSON.stringify(probe.json))
  if (!probe.json?.supportsVision) fail('probe vision', probe.json?.message)
  ok('POST /model-gateway/probe', probe.json.message)

  // 2. 建大屏 + SSE
  const created = await api('POST', '/dashboards', { name: '冒烟测试大屏' })
  const dash = created.json
  if (!dash?.id) fail('POST /dashboards', JSON.stringify(created.json))
  ok('POST /dashboards', `${dash.name} (${dash.id})`)

  const sse = openSse(dash.id)

  // 3. 发消息（带参考图）
  await api('POST', `/dashboards/${dash.id}/messages`, {
    text: '做一个服务器监控大屏，看 CPU、内存和网络',
    attachments: [PIXEL]
  })
  const clarBlocker = await sse.waitFor('blocker', (e) => e.data?.blocker?.type === 'clarification', 60_000, '澄清卡点')
  ok('SSE: 带图消息 → 分析参考图片 → 澄清卡点', clarBlocker.data.blocker.title)
  const clarMsg = sse.events.find((e) => e.event === 'message' && e.data?.message?.kind === 'clarification')
  if (!clarMsg) fail('澄清卡片消息')
  const qCount = clarMsg.data.message.questions.length
  if (qCount < 1 || qCount > 3) fail('澄清问题数量 ≤3', `实际 ${qCount}`)
  for (const q of clarMsg.data.message.questions) {
    const rec = q.options.filter((o) => o.recommended)
    if (rec.length !== 1) fail('每题恰一个 ★推荐', `${q.question}: ${rec.length} 个`)
  }
  ok('澄清卡片规范', `${qCount} 题，每题恰一个 ★推荐`)
  if (!sse.events.some((e) => e.event === 'stage')) fail('SSE stage 事件')
  ok('SSE: message / stage / runStatus / blocker 事件均在流出')

  // 4. 回答澄清 → 等 previewReady
  const answers = clarMsg.data.message.questions.map((q) => ({
    questionId: q.id,
    optionId: q.options.find((o) => o.recommended).id,
    customText: ''
  }))
  await api('POST', `/dashboards/${dash.id}/messages/${clarMsg.data.message.id}/answers`, { answers })
  // 首次创建：编码过程中应有实时预览事件（部分 HTML 逐步刷新）
  const buildingEvt = await sse.waitFor('previewBuilding', null, 90_000, 'previewBuilding 实时预览')
  ok('编码中实时预览（previewBuilding）', buildingEvt.data.url)
  const buildingHtml = await (await fetch(`${BASE}${buildingEvt.data.url}`)).text()
  if (buildingHtml.length < 500) fail('实时预览页有实际内容', `仅 ${buildingHtml.length} 字节`)
  ok('实时预览页可访问且有内容', `${buildingHtml.length} 字节`)
  const ready = await sse.waitFor('previewReady', null, 90_000, 'previewReady(v1)')
  ok('回答澄清 → previewReady', ready.data.url)
  const vAdded = sse.events.find((e) => e.event === 'versionAdded')
  if (!vAdded) fail('versionAdded 事件')
  ok('versionAdded', `${vAdded.data.version.label}「${vAdded.data.version.summary}」`)
  await sse.waitFor('runStatus', (e) => e.data?.status === 'idle', 30_000, 'runStatus idle')

  // 5. 预览 HTML：200 且无外部引用
  const htmlRes = await fetch(`${BASE}${ready.data.url}`)
  const html = await htmlRes.text()
  if (htmlRes.status !== 200) fail('GET 预览 HTML', `HTTP ${htmlRes.status}`)
  if (!/<html[\s>]/i.test(html)) fail('预览是完整 HTML')
  if (/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html)) fail('预览无外部资源引用')
  ok('GET 预览 HTML 200，自包含，无外部引用', `${html.length} 字节`)

  // 6. 再发一条不带图的修改消息 → v2
  await api('POST', `/dashboards/${dash.id}/messages`, { text: '把 CPU 的图放大一点' })
  const ready2 = await sse.waitFor(
    'previewReady',
    (e) => e.data?.versionId !== ready.data.versionId,
    90_000,
    'previewReady(v2)'
  )
  ok('不带图修改消息 → v2 previewReady', ready2.data.url)

  // 7. 回退 → 新节点
  const versions = (await api('GET', `/dashboards/${dash.id}/versions`)).json
  const v1 = versions.find((v) => v.label === 'v1')
  await api('POST', `/dashboards/${dash.id}/versions/${v1.id}/rollback`)
  const rb = await sse.waitFor('versionAdded', (e) => /回退到/.test(e.data?.version?.summary ?? ''), 30_000, '回退新节点')
  ok('rollback → 新节点', `${rb.data.version.label}「${rb.data.version.summary}」`)

  // 8. 发布 → 5 秒后已发布
  await api('POST', `/dashboards/${dash.id}/publish`)
  const pub = await sse.waitFor('dashboardUpdated', (e) => e.data?.dashboard?.status === 'published', 30_000, '发布审批通过')
  ok('publish → 审批通过', `徽标变为「已发布」(${pub.data.dashboard.name})`)

  // 8.5 阶段时间线：新建流程必须是 6 步，含「视觉检查」「修复问题」
  const titles = [...new Set(sse.events.filter((e) => e.event === 'stage').map((e) => e.data?.stage?.title).filter(Boolean))]
  for (const t of ['视觉检查', '修复问题']) {
    if (!titles.includes(t)) fail(`阶段时间线含「${t}」`, `实际阶段：${titles.join(' → ')}`)
  }
  ok('阶段时间线含「视觉检查」「修复问题」', titles.join(' → '))

  // 8.6 修复路径演练：stub 在 HTML 里埋视觉问题标记 → 视觉检查报问题 → Issue 卡 → 自动修复 → previewReady
  const dash2 = (await api('POST', '/dashboards', { name: '修复演示大屏' })).json
  const sse2 = openSse(dash2.id)
  await api('POST', `/dashboards/${dash2.id}/messages`, { text: '演示视觉修复：做一个监控大屏' })
  const clar2 = await sse2.waitFor('message', (e) => e.data?.message?.kind === 'clarification', 60_000, '大屏2 澄清卡片')
  await api('POST', `/dashboards/${dash2.id}/messages/${clar2.data.message.id}/answers`, {
    answers: clar2.data.message.questions.map((q) => ({
      questionId: q.id,
      optionId: q.options.find((o) => o.recommended).id,
      customText: ''
    }))
  })
  const fixing = await sse2.waitFor('issue', (e) => e.data?.issue?.status === 'fixing', 90_000, 'Issue 进入修复')
  ok('视觉检查发现问题 → Issue 卡', `${fixing.data.issue.title}（第 ${fixing.data.issue.attempt} 次尝试）`)
  const fixed = await sse2.waitFor('issue', (e) => e.data?.issue?.status === 'fixed', 90_000, 'Issue 修复完成')
  ok('自动修复成功 → Issue FIXED', fixed.data.issue.detail)
  await sse2.waitFor('previewReady', null, 90_000, '大屏2 previewReady')
  const repairStage = sse2.events.find((e) => e.event === 'stage' && e.data?.stage?.title === '修复问题' && e.data?.stage?.state === 'done')
  if (!repairStage) fail('「修复问题」阶段完成')
  ok('「修复问题」阶段走完 → previewReady')
  sse2.close()

  // 9. Last-Event-ID 补发抽查
  const replay = openSse(dash.id, { 'Last-Event-ID': '1' })
  const first = await replay.waitFor('message', null, 10_000, 'Last-Event-ID 补发')
  if (!(first.id > 1)) fail('补发事件 seq > Last-Event-ID', `实际 seq=${first.id}`)
  ok('Last-Event-ID 补发', `从 seq=2 开始补，首条 seq=${first.id}`)
  replay.close()
  sse.close()

  console.log(`== 冒烟通过（${passed} 项断言）==`)
  cleanup()
  process.exit(0)
}

main().catch((err) => {
  console.error('== 冒烟失败 ==')
  console.error(err)
  cleanup()
  process.exit(1)
})
