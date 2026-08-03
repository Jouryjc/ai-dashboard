#!/usr/bin/env node
/**
 * smoke.mjs —— 端到端冒烟（可重复执行）：npm run smoke
 *
 * 步骤：
 *   1. 启动 stub LLM（9100）+ stub MCP（正常 + --down 各一）+ 服务端（8787，独立数据目录 data-smoke，先清空）
 *   2. PUT settings 指向 stub → POST probe 返回 ok 且支持看图
 *   2.5 PUT data-sources 指向 stub MCP → GET 回读一致 → probe 发现 get_metrics（错令牌 → ok=false）
 *   3. POST 建大屏 → 发消息（带参考图）→ 订阅 SSE 看 message/stage/blocker 流出
 *   4. 回答澄清 → 「获取数据」阶段 active→done → 等 previewReady → GET 预览 HTML 200、无外部引用、含 88.8%
 *   5. 再发一条不带图的修改消息 → 等 v2 previewReady
 *   6. rollback → 新节点；publish → 5 秒后已发布
 *   7. 断源链路：数据源换 --down stub → 「数据源连不上」卡点卡 → 再试仍摆卡 → 改用演示数据照常出预览
 *   8. 重启服务端（DATA_DIR 保留）→ 数据源配置恢复 + 数据快照落盘 + 编辑复用快照不重取数
 *   9. Last-Event-ID 补发抽查
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'

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
let PREVIEW_BASE = ''
let STUB_PORT = 0
const MASKED_SECRET = '••••••••'

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
    headers: { 'Content-Type': 'application/json', 'X-AI-Dashboard-Client': '1' },
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
  const noVisionPort = await freePort()
  const serverPort = Number(process.env.SMOKE_PORT ?? (await freePort()))
  const previewPort = await freePort()
  BASE = `http://127.0.0.1:${serverPort}`
  PREVIEW_BASE = `http://127.0.0.1:${previewPort}`

  startProc('stub', process.execPath, [path.join(SERVER_DIR, 'scripts/stub-llm.mjs'), String(STUB_PORT)])
  startProc('stub-no-vision', process.execPath, [
    path.join(SERVER_DIR, 'scripts/stub-llm.mjs'),
    String(noVisionPort),
    '--no-vision'
  ])
  const MCP_PORT = await freePort()
  const MCP_DOWN_PORT = await freePort()
  startProc('stub-mcp', process.execPath, [path.join(SERVER_DIR, 'scripts/stub-mcp.mjs'), String(MCP_PORT), '--token=mcp-smoke-token'])
  startProc('stub-mcp-down', process.execPath, [path.join(SERVER_DIR, 'scripts/stub-mcp.mjs'), String(MCP_DOWN_PORT), '--down'])
  const tsxCli = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const serverEnv = {
    PORT: String(serverPort),
    PREVIEW_PORT: String(previewPort),
    PREVIEW_ORIGIN: PREVIEW_BASE,
    DATA_DIR,
    // 冒烟里把 20 分钟看门狗压到 3 秒，用于演练"超时 → 拆分步骤"
    AGENT_STEP_MAX_MS: '3000',
    // MCP 调用 15 秒超时压到 2 秒（与看门狗同款压缩），断源链路不用干等
    MCP_CALL_TIMEOUT_MS: '2000'
  }
  let serverProc = startProc('server', process.execPath, [tsxCli, path.join(SERVER_DIR, 'src/index.ts')], serverEnv)

  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 30_000, '服务端启动')
  ok(`stub(${STUB_PORT}) + stub-mcp(${MCP_PORT}) + 服务端(${serverPort}) 已启动`)

  // 1. settings → probe
  const emptyRole = { model: '', apiBase: '', apiKey: '' }
  const put = await api('PUT', '/settings', {
    provider: '冒烟测试',
    apiBase: `http://127.0.0.1:${STUB_PORT}/v1`,
    apiKey: 'sk-smoke',
    model: 'stub-1',
    planner: { ...emptyRole },
    coder: { ...emptyRole },
    vision: { ...emptyRole }
  })
  if (put.status !== 204) fail('PUT /settings', `HTTP ${put.status}`)
  const probe = await api('POST', '/model-gateway/probe', {
    settings: (await api('GET', '/settings')).json
  })
  if (!probe.json?.ok) fail('probe 连通', JSON.stringify(probe.json))
  if (!probe.json?.supportsVision) fail('probe vision', probe.json?.message)
  ok('POST /model-gateway/probe', probe.json.message)

  // 1.25 统一项目模型：业务应用能创建、回读和删除
  const businessAppProjectRes = await api('POST', '/projects', {
    name: '云主机管理页',
    artifactKind: 'business-app'
  })
  const businessAppProject = businessAppProjectRes.json
  if (
    businessAppProjectRes.status !== 200 ||
    businessAppProject?.artifactKind !== 'business-app' ||
    businessAppProject?.targetProfile?.framework !== 'vue3' ||
    businessAppProject?.targetProfile?.uiLibrary !== 'idux'
  ) {
    fail('POST /projects 创建业务应用项目', JSON.stringify(businessAppProject))
  }
  const projects = (await api('GET', '/projects')).json
  if (!Array.isArray(projects) || !projects.some((project) => project.id === businessAppProject.id)) {
    fail('GET /projects 回读项目', JSON.stringify(projects))
  }
  ok('Project/ArtifactKind/TargetProfile 统一 API', businessAppProject.id)
  const capabilities = (await api('GET', '/generation-capabilities')).json
  const businessAppCapability = capabilities?.find?.((item) => item.artifactKind === 'business-app')
  const businessAppSkillIds = businessAppCapability?.skills?.map?.((skill) => skill.id) ?? []
  if (!businessAppSkillIds.includes('idux-cli') || !businessAppSkillIds.includes('idux-style')) {
    fail('Skill Registry 暴露业务应用能力', JSON.stringify(capabilities))
  }
  ok('Artifact Registry + Skill Registry 能力发现', businessAppCapability.skills.map((skill) => skill.id).join('、'))
  const tableIntent = await api('POST', '/generation-intent', {
    text: '生成一个包含云主机相关信息的表格'
  })
  if (
    tableIntent.json?.artifactKind !== 'business-app' ||
    tableIntent.json?.requiresClarification !== false
  ) {
    fail('云主机表格意图路由到业务应用', JSON.stringify(tableIntent.json))
  }
  const ambiguousIntent = await api('POST', '/generation-intent', { text: '帮我做个页面' })
  if (
    ambiguousIntent.json?.artifactKind !== null ||
    ambiguousIntent.json?.requiresClarification !== true ||
    ambiguousIntent.json?.candidates?.length !== 2
  ) {
    fail('模糊意图要求用户澄清产物类型', JSON.stringify(ambiguousIntent.json))
  }
  const missingKind = await api('POST', '/projects', { name: '不应静默创建' })
  if (missingKind.status !== 400) {
    fail('项目创建不允许静默默认成大屏', `HTTP ${missingKind.status}`)
  }
  ok('意图路由：云主机表格 → 业务应用；模糊需求 → 澄清；创建不静默默认')

  // 1.3 业务应用闭环：技能证据 → 受控构建 → 浏览器门禁 → 独立预览 → ZIP 源码
  const businessAppSse = openSse(businessAppProject.id)
  await api('POST', `/dashboards/${businessAppProject.id}/messages`, {
    text: '根据参考图生成一个包含云主机相关信息的表格页面',
    attachments: [PIXEL]
  })
  const businessAppReady = await waitFor(() => {
    const failed = businessAppSse.events.find(
      (event) => event.event === 'issue' && event.data?.issue?.status === 'failed'
    )
    if (failed) throw new Error(`业务应用门禁失败：${failed.data.issue.title}`)
    return businessAppSse.events.find(event => event.event === 'previewReady')
  }, 150_000, '业务应用 previewReady')
  const businessAppVersions = (await api('GET', `/dashboards/${businessAppProject.id}/versions`)).json
  const businessAppVersion = businessAppVersions?.[0]
  if (
    businessAppVersion?.manifest?.kind !== 'business-app' ||
    businessAppVersion?.manifest?.exportFormat !== 'zip' ||
    businessAppVersion?.validationReport?.status !== 'passed' ||
    businessAppVersion.validationReport.gates.some((gate) => gate.status !== 'passed')
  ) {
    fail('业务应用版本通过全部质量门禁', JSON.stringify(businessAppVersion))
  }
  ok('idux-cli + idux-style 证据 → 业务应用构建 → 双视口门禁', `${businessAppVersion.validationReport.gates.length} 项通过`)
  const businessAppPreview = await fetch(businessAppReady.data.url)
  const businessAppPreviewHtml = await businessAppPreview.text()
  if (
    businessAppPreview.status !== 200 ||
    new URL(businessAppPreview.url).origin !== PREVIEW_BASE ||
    !businessAppPreviewHtml.includes('./assets/')
  ) {
    fail('业务应用在独立预览 origin 加载构建产物', businessAppPreview.url)
  }
  ok('业务应用构建产物在独立 origin 预览', businessAppPreview.url)
  const businessAppExport = await fetch(
    `${BASE}/api/v1/dashboards/${businessAppProject.id}/versions/${businessAppVersion.id}/export`
  )
  const businessAppZip = new Uint8Array(await businessAppExport.arrayBuffer())
  if (
    businessAppExport.status !== 200 ||
    !(businessAppExport.headers.get('content-type') ?? '').includes('application/zip') ||
    businessAppZip[0] !== 0x50 ||
    businessAppZip[1] !== 0x4b
  ) {
    fail('业务应用导出 ZIP', `HTTP ${businessAppExport.status}`)
  }
  const businessAppFiles = unzipSync(businessAppZip)
  const businessAppPackage = JSON.parse(strFromU8(businessAppFiles['package.json']))
  const businessAppSource = strFromU8(businessAppFiles['src/App.vue'])
  const businessAppBlueprint = JSON.parse(strFromU8(businessAppFiles['src/contracts/application-blueprint.json']))
  const businessAppEvidence = JSON.parse(strFromU8(businessAppFiles['generation-evidence.json']))
  if (
    businessAppPackage.dependencies?.['@idux/components'] !== '2.11.0' ||
    !businessAppSource.includes('<IxTable') ||
    !businessAppFiles['src/styles/app-shell.css'] ||
    !businessAppFiles['src/contracts/requirement-contract.json'] ||
    !businessAppFiles['src/contracts/change-plan.json'] ||
    !businessAppFiles['src/contracts/acceptance-plan.json'] ||
    !businessAppEvidence.skills?.includes('idux-cli') ||
    !businessAppEvidence.skills?.includes('idux-style') ||
    JSON.stringify(businessAppEvidence.style?.viewports) !== JSON.stringify(['1920x1080', '1366x768']) ||
    businessAppEvidence.reference?.mode !== 'vision-structured-spec' ||
    businessAppEvidence.reference?.analyzer !== 'business-app-reference-v2' ||
    !/^[0-9a-f]{64}$/.test(businessAppEvidence.reference?.imageSha256 ?? '') ||
    businessAppBlueprint.shell?.navigation !== 'side' ||
    /data:image\//i.test(strFromU8(businessAppFiles['generation-evidence.json']))
  ) {
    fail('业务应用 ZIP 含可复现源码与精确依赖', Object.keys(businessAppFiles).join('、'))
  }
  ok('业务应用参考图 → 结构化规格 → 双视口源码 ZIP', Object.keys(businessAppFiles).join('、'))

  // 增量需求必须保留首轮业务目标与参考图蓝图，并以真实交互场景验收详情视图。
  await api('POST', `/dashboards/${businessAppProject.id}/messages`, { text: '增加详情页面' })
  const businessAppDetailReady = await businessAppSse.waitFor(
    'previewReady',
    event => event.data?.versionId !== businessAppVersion.id,
    180_000,
    '业务应用累计需求详情页 previewReady'
  )
  const detailVersions = (await api('GET', `/dashboards/${businessAppProject.id}/versions`)).json
  const detailVersion = detailVersions?.[0]
  const detailGateIds = detailVersion?.validationReport?.gates
    ?.filter(gate => gate.status === 'passed')
    .map(gate => gate.id) ?? []
  if (
    detailVersion?.validationReport?.status !== 'passed' ||
    !detailGateIds.includes('scenario-cloud-host-scenario-detail-1920x1080') ||
    !detailGateIds.includes('scenario-cloud-host-scenario-detail-1366x768')
  ) {
    fail('业务应用详情增量通过双视口任务场景', JSON.stringify(detailVersion?.validationReport))
  }
  const detailExport = await fetch(
    `${BASE}/api/v1/dashboards/${businessAppProject.id}/versions/${detailVersion.id}/export`
  )
  const detailFiles = unzipSync(new Uint8Array(await detailExport.arrayBuffer()))
  const detailApp = strFromU8(detailFiles['src/App.vue'])
  const detailBlueprint = JSON.parse(strFromU8(detailFiles['src/contracts/application-blueprint.json']))
  const detailEvidence = JSON.parse(strFromU8(detailFiles['generation-evidence.json']))
  const cloudModule = detailBlueprint.modules?.find(module => module.id === 'cloud-host')
  if (
    !detailApp.includes("activeView.kind === 'detail'") ||
    !cloudModule?.views?.some(view => view.kind === 'detail') ||
    detailBlueprint.shell?.navigation !== 'side' ||
    detailEvidence.reference?.analyzer !== 'business-app-reference-v2' ||
    !detailEvidence.componentQueries?.some(query => query.args?.includes('desc'))
  ) {
    fail('业务应用增量修改保留累计需求、参考图与动态组件证据')
  }
  ok(
    '业务应用累计需求 → 真实详情页 → 双视口交互复检',
    `${businessAppDetailReady.data.url}；${detailGateIds.filter(id => id.startsWith('scenario-')).join('、')}`
  )
  await api('POST', `/dashboards/${businessAppProject.id}/versions/${businessAppVersion.id}/rollback`)
  const businessAppRollback = await businessAppSse.waitFor(
    'versionAdded',
    event => /回退到/.test(event.data?.version?.summary ?? ''),
    30_000,
    '业务应用多文件版本回退'
  )
  const rolledPreview = await fetch(businessAppRollback.data.version
    ? `${PREVIEW_BASE}/preview/${businessAppProject.id}/${businessAppRollback.data.version.id}/index.html`
    : '')
  const rolledExport = await fetch(
    `${BASE}/api/v1/dashboards/${businessAppProject.id}/versions/${businessAppRollback.data.version.id}/export`
  )
  const rolledZip = new Uint8Array(await rolledExport.arrayBuffer())
  if (!rolledPreview.ok || rolledZip[0] !== 0x50 || rolledZip[1] !== 0x4b) {
    fail('业务应用回退保留构建资源与源码 ZIP')
  }
  ok('业务应用回退复制多文件构建产物与源码，不破坏历史版本')
  businessAppSse.close()
  await api('DELETE', `/projects/${businessAppProject.id}`)

  // 关键歧义一次只问一个，并通过持久化 Loop 检查点逐轮恢复。
  const clarificationProject = (await api('POST', '/projects', {
    name: '库存业务应用澄清', artifactKind: 'business-app'
  })).json
  const clarificationSse = openSse(clarificationProject.id)
  await api('POST', `/dashboards/${clarificationProject.id}/messages`, {
    text: '新增一个完整的库存管理模块'
  })
  const businessClarification1 = await clarificationSse.waitFor(
    'message', event => event.data?.message?.kind === 'clarification', 60_000, '业务应用第一轮单问题澄清'
  )
  if (businessClarification1.data.message.questions?.length !== 1) {
    fail('业务应用第一轮只询问一个关键问题', JSON.stringify(businessClarification1.data.message))
  }
  const question1 = businessClarification1.data.message.questions[0]
  await api('POST', `/dashboards/${clarificationProject.id}/messages/${businessClarification1.data.message.id}/answers`, {
    answers: [{ questionId: question1.id, optionId: question1.options.find(option => option.recommended).id, customText: '' }]
  })
  const businessClarification2 = await clarificationSse.waitFor(
    'message',
    event => event.data?.message?.kind === 'clarification' && event.data.message.id !== businessClarification1.data.message.id,
    60_000,
    '业务应用第二轮单问题澄清'
  )
  if (businessClarification2.data.message.questions?.length !== 1) {
    fail('业务应用第二轮仍只询问一个关键问题', JSON.stringify(businessClarification2.data.message))
  }
  const question2 = businessClarification2.data.message.questions[0]
  await api('POST', `/dashboards/${clarificationProject.id}/messages/${businessClarification2.data.message.id}/answers`, {
    answers: [{ questionId: question2.id, optionId: question2.options.find(option => option.recommended).id, customText: '' }]
  })
  await clarificationSse.waitFor('previewReady', null, 180_000, '业务应用澄清完成后恢复 Loop 并交付')
  const clarificationSnapshot = (await api('POST', `/dashboards/${clarificationProject.id}/enter`)).json
  if (clarificationSnapshot?.runStatus !== 'idle') {
    fail('业务应用澄清检查点在交付后正确收尾', JSON.stringify(clarificationSnapshot?.runStatus))
  }
  ok('业务应用逐轮单问题澄清 → JSON 检查点恢复 → 完整 Loop 交付')
  clarificationSse.close()
  await api('DELETE', `/projects/${clarificationProject.id}`)

  // 1.4 图片复刻不能静默降级：模型不支持看图时明确失败，不生成无关通用页面
  await api('PUT', '/settings', {
    provider: '无视觉冒烟测试',
    apiBase: `http://127.0.0.1:${noVisionPort}/v1`,
    apiKey: 'sk-smoke',
    model: 'stub-no-vision',
    planner: { ...emptyRole },
    coder: { ...emptyRole },
    vision: { ...emptyRole }
  })
  const noVisionProject = (await api('POST', '/projects', {
    name: '不应忽略参考图',
    artifactKind: 'business-app'
  })).json
  const noVisionSse = openSse(noVisionProject.id)
  await api('POST', `/dashboards/${noVisionProject.id}/messages`, {
    text: '根据这张参考图生成页面',
    attachments: [PIXEL]
  })
  const noVisionIssue = await noVisionSse.waitFor(
    'issue',
    event => event.data?.issue?.status === 'failed',
    30_000,
    '业务应用无视觉能力明确失败'
  )
  if (
    !/不支持图片理解/.test(noVisionIssue.data?.issue?.title ?? '') ||
    noVisionSse.events.some(event => event.event === 'previewReady')
  ) {
    fail('业务应用图片复刻不允许静默降级', JSON.stringify(noVisionIssue.data))
  }
  const noVisionSnapshot = (await api('POST', `/dashboards/${noVisionProject.id}/enter`)).json
  if (
    noVisionSnapshot?.runStatus !== 'blocked' ||
    noVisionSnapshot?.stages?.some(stage => stage.state === 'active') ||
    !noVisionSnapshot?.stages?.some(stage => stage.state === 'failed')
  ) {
    fail('业务应用失败状态保持一致', JSON.stringify({
      runStatus: noVisionSnapshot?.runStatus,
      stages: noVisionSnapshot?.stages
    }))
  }
  ok('业务应用模型不支持看图时明确失败，且无 idle + active 假状态')
  noVisionSse.close()
  await api('DELETE', `/projects/${noVisionProject.id}`)
  await api('PUT', '/settings', {
    provider: '冒烟测试',
    apiBase: `http://127.0.0.1:${STUB_PORT}/v1`,
    apiKey: 'sk-smoke',
    model: 'stub-1',
    planner: { ...emptyRole },
    coder: { ...emptyRole },
    vision: { ...emptyRole }
  })

  // 1.5 MCP 数据源：PUT 全量列表（自动补 id）→ GET 回读一致 → probe 发现 get_metrics；错令牌 → ok=false 大白话
  const goodSource = {
    name: '经营指标库',
    url: `http://127.0.0.1:${MCP_PORT}`,
    authType: 'bearer',
    token: 'mcp-smoke-token',
    headerName: '',
    enabled: true
  }
  const putDs = await api('PUT', '/data-sources', [goodSource])
  if (putDs.status !== 200 || !Array.isArray(putDs.json) || putDs.json.length !== 1) {
    fail('PUT /data-sources', `HTTP ${putDs.status}: ${JSON.stringify(putDs.json)}`)
  }
  const dsSaved = putDs.json[0]
  if (!dsSaved.id) fail('PUT 自动补 id', JSON.stringify(dsSaved))
  const dsBack = (await api('GET', '/data-sources')).json?.[0]
  if (!dsBack || dsBack.id !== dsSaved.id || dsBack.url !== goodSource.url || dsBack.token !== MASKED_SECRET || dsBack.enabled !== true) {
    fail('GET /data-sources 回读一致', JSON.stringify(dsBack))
  }
  ok('PUT /data-sources → GET 回读脱敏（自动补 id）', dsSaved.id)
  const dsProbe = await api('POST', '/data-sources/probe', { source: dsBack })
  if (!dsProbe.json?.ok) fail('数据源 probe 连通', JSON.stringify(dsProbe.json))
  if (!dsProbe.json.tools.includes('get_metrics')) fail('probe 发现 get_metrics 工具', JSON.stringify(dsProbe.json.tools))
  ok('POST /data-sources/probe', `${dsProbe.json.message}（${dsProbe.json.tools.join('、')}）`)
  const badProbe = await api('POST', '/data-sources/probe', { source: { ...dsBack, token: 'wrong-token' } })
  if (badProbe.json?.ok !== false || !/令牌/.test(badProbe.json?.message ?? '')) {
    fail('错令牌 probe → ok=false 大白话', JSON.stringify(badProbe.json))
  }
  ok('错令牌 probe → ok=false（大白话报错）', badProbe.json.message)

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
  const buildingHtml = await (await fetch(new URL(buildingEvt.data.url, BASE))).text()
  if (buildingHtml.length < 500) fail('实时预览页有实际内容', `仅 ${buildingHtml.length} 字节`)
  ok('实时预览页可访问且有内容', `${buildingHtml.length} 字节`)
  const matchMsg = await sse.waitFor(
    'message',
    (e) => e.data?.message?.kind === 'agent' && /模板匹配好了/.test(e.data?.message?.text ?? ''),
    90_000,
    '模板匹配结果'
  )
  ok('模板匹配环节 → 命中消息', matchMsg.data.message.text.slice(0, 50) + '…')
  const ready = await sse.waitFor('previewReady', null, 90_000, 'previewReady(v1)')
  ok('回答澄清 → previewReady', ready.data.url)
  const vAdded = sse.events.find((e) => e.event === 'versionAdded')
  if (!vAdded) fail('versionAdded 事件')
  ok('versionAdded', `${vAdded.data.version.label}「${vAdded.data.version.summary}」`)
  await sse.waitFor('runStatus', (e) => e.data?.status === 'idle', 30_000, 'runStatus idle')

  // 5. 预览 HTML：200 且无外部引用
  const htmlRes = await fetch(new URL(ready.data.url, BASE))
  const html = await htmlRes.text()
  if (htmlRes.status !== 200) fail('GET 预览 HTML', `HTTP ${htmlRes.status}`)
  if (new URL(htmlRes.url).origin !== PREVIEW_BASE) fail('预览运行在独立 origin', htmlRes.url)
  if (!htmlRes.headers.get('content-security-policy')?.includes("connect-src 'none'")) {
    fail('预览响应带严格 CSP', String(htmlRes.headers.get('content-security-policy')))
  }
  if (!/<html[\s>]/i.test(html)) fail('预览是完整 HTML')
  if (/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html)) fail('预览无外部资源引用')
  ok('GET 预览 HTML 200，自包含，无外部引用', `${html.length} 字节`)
  const dataRes = await fetch(new URL('./data.json', ready.data.url))
  const previewData = await dataRes.text()
  if (!dataRes.ok || !previewData.includes('88.8')) {
    fail('MCP 真实数据独立落盘（data.json 含 88.8）', `HTTP ${dataRes.status}: ${previewData.slice(0, 200)}`)
  }
  if (!/fetch\(\s*['"]\.\/data\.json['"]\s*\)/.test(html)) {
    fail('预览 HTML 保留 data.json 安全回退读取器')
  }
  if (!/id\s*=\s*["']dashboard-data["']/.test(html) || !html.includes('88.8')) {
    fail('预览响应安全内联事实数据')
  }
  ok('MCP 真实数据与生成代码分离', 'data.json 独立落盘，响应时内联且 CSP 禁止联网')

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

  // 8. 发布安全：配置接口不回传密钥；缺少配置时明确失败，不能伪装成已发布
  await api('PUT', '/publish-config', {
    endpoint: '',
    accessKey: 'ak-smoke-secret',
    secretKey: 'smoke-secret-not-a-real-credential'
  })
  const maskedPublishConfig = (await api('GET', '/publish-config')).json
  if (
    maskedPublishConfig?.accessKey !== MASKED_SECRET ||
    maskedPublishConfig?.secretKey !== MASKED_SECRET
  ) {
    fail('发布配置密钥回读脱敏', JSON.stringify(maskedPublishConfig))
  }
  await api('PUT', '/publish-config', { endpoint: '', accessKey: '', secretKey: '' })
  await api('POST', `/dashboards/${dash.id}/publish`)
  const publishFailed = await sse.waitFor(
    'publishProgress',
    (e) => e.data?.phase === 'failed',
    30_000,
    '缺少发布配置时失败'
  )
  const afterFailedPublish = (await api('GET', '/dashboards')).json.find((item) => item.id === dash.id)
  if (afterFailedPublish?.status === 'published') {
    fail('发布失败不能把项目标记为已发布')
  }
  ok('发布配置脱敏；缺少配置时安全失败', publishFailed.data.error)

  // 8.5 阶段时间线：新建流程必须是 7 步（含「获取数据」），含「视觉检查」「修复问题」
  const titles = [...new Set(sse.events.filter((e) => e.event === 'stage').map((e) => e.data?.stage?.title).filter(Boolean))]
  for (const t of ['匹配模板', '获取数据', '视觉检查', '修复问题']) {
    if (!titles.includes(t)) fail(`阶段时间线含「${t}」`, `实际阶段：${titles.join(' → ')}`)
  }
  ok('阶段时间线含「获取数据」「视觉检查」「修复问题」', titles.join(' → '))
  const fetchStages = sse.events.filter((e) => e.event === 'stage' && e.data?.stage?.title === '获取数据')
  if (!fetchStages.some((e) => e.data.stage.state === 'active') || !fetchStages.some((e) => e.data.stage.state === 'done')) {
    fail('「获取数据」阶段经历 active → done', fetchStages.map((e) => e.data.stage.state).join(','))
  }
  ok('「获取数据」阶段经历 active → done')

  // 8.5+ 执行轨迹（观测性 §2.3）：每个阶段节点下有具体动作，新一轮首条带 reset，收尾无"永远进行中"
  const stepEvents = sse.events.filter((e) => e.event === 'step')
  if (stepEvents.length === 0) fail('执行轨迹 step 事件流出')
  if (!stepEvents.some((e) => e.data?.reset === true)) fail('新一轮首个 step 事件带 reset=true')
  const stepTitles = stepEvents.map((e) => e.data?.step?.title ?? '')
  for (const t of ['分析你的需求', '规划要取哪些数据', '取数 1/', '编写页面', '硬性规则检查']) {
    if (!stepTitles.some((x) => x.includes(t))) fail(`执行轨迹含「${t}」`, stepTitles.join(' | '))
  }
  ok('执行轨迹：动作流覆盖 分析/取数/编写/检查', `${stepEvents.length} 条 step 事件`)
  const snap1 = (await api('POST', `/dashboards/${dash.id}/enter`)).json
  if (!Array.isArray(snap1.steps) || snap1.steps.length === 0) fail('快照含执行轨迹 steps')
  const activeLeft = snap1.steps.filter((s) => s.state === 'active')
  if (activeLeft.length > 0) fail('收尾后无进行中动作', activeLeft.map((s) => s.title).join(' | '))
  ok('快照含执行轨迹，收尾后无"永远进行中"动作', `${snap1.steps.length} 条`)

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

  // 8.7 超时拆分：慢编码触发 20 分钟看门狗（冒烟压到 3s）→ 自动拆分步骤（骨架 → 面板）→ previewReady
  const dash3 = (await api('POST', '/dashboards', { name: '拆分演示大屏' })).json
  const sse3 = openSse(dash3.id)
  await api('POST', `/dashboards/${dash3.id}/messages`, { text: 'SLOWCODER 做一个监控大屏' })
  const clar3 = await sse3.waitFor('message', (e) => e.data?.message?.kind === 'clarification', 60_000, '大屏3 澄清卡片')
  await api('POST', `/dashboards/${dash3.id}/messages/${clar3.data.message.id}/answers`, {
    answers: clar3.data.message.questions.map((q) => ({
      questionId: q.id,
      optionId: q.options.find((o) => o.recommended).id,
      customText: ''
    }))
  })
  const splitMsg = await sse3.waitFor(
    'message',
    (e) => e.data?.message?.kind === 'agent' && /拆成几步/.test(e.data?.message?.text ?? ''),
    60_000,
    '超时拆分提示'
  )
  ok('编码超时 → 自动拆分步骤', splitMsg.data.message.text)
  await sse3.waitFor('previewReady', null, 90_000, '大屏3 previewReady')
  const splitReadyUrl = sse3.events.find((e) => e.event === 'previewReady').data.url
  const splitHtml = await (await fetch(new URL(splitReadyUrl, BASE))).text()
  if (!/核心指标|趋势图表/.test(splitHtml)) fail('拆分生成的页面包含面板内容', `仅 ${splitHtml.length} 字节`)
  ok('拆分步骤完成（骨架+面板拼装）→ previewReady', `${splitHtml.length} 字节`)
  sse3.close()

  // 8.8 模板匹配不上 → 确认卡片（★自定义生成）→ 选择后继续 → previewReady
  const dash4 = (await api('POST', '/dashboards', { name: '自定义演示大屏' })).json
  const sse4 = openSse(dash4.id)
  await api('POST', `/dashboards/${dash4.id}/messages`, { text: '完全自定义需求：做一个 3D 地球主视觉的大屏' })
  const clar4 = await sse4.waitFor('message', (e) => e.data?.message?.kind === 'clarification', 60_000, '大屏4 澄清卡片')
  await api('POST', `/dashboards/${dash4.id}/messages/${clar4.data.message.id}/answers`, {
    answers: clar4.data.message.questions.map((q) => ({
      questionId: q.id,
      optionId: q.options.find((o) => o.recommended).id,
      customText: ''
    }))
  })
  const confirmCard = await sse4.waitFor(
    'message',
    (e) => e.data?.message?.kind === 'problem' && e.data?.message?.options?.some((o) => o.id === 'opt-custom-generate'),
    90_000,
    '模板无匹配确认卡片'
  )
  const rec = confirmCard.data.message.options.filter((o) => o.recommended)
  if (rec.length !== 1 || rec[0].id !== 'opt-custom-generate') fail('★推荐恰为「自定义生成组件」', JSON.stringify(rec))
  ok('模板匹配不上 → 确认卡片（★自定义生成）', confirmCard.data.message.title)
  await api('POST', `/dashboards/${dash4.id}/options/opt-custom-generate`)
  await sse4.waitFor('previewReady', null, 90_000, '大屏4 previewReady')
  ok('选「自定义生成组件」→ 流程继续 → previewReady')
  sse4.close()

  // 8.9 封面上传：合法 1×1 PNG → 204 → coverUrl 带时间戳 → 可访问且是 PNG；垃圾数据 → 400
  const coverRes = await api('POST', `/dashboards/${dash.id}/cover`, { image: PIXEL })
  if (coverRes.status !== 204) fail('POST /cover 返回 204', `HTTP ${coverRes.status}: ${JSON.stringify(coverRes.json)}`)
  ok('上传 1×1 PNG 封面 → 204')
  const dashAfterCover = (await api('GET', '/dashboards')).json.find((d) => d.id === dash.id)
  const coverUrl = dashAfterCover?.coverUrl ?? ''
  if (!new RegExp(`^/covers/${dash.id}\\.png\\?t=\\d+$`).test(coverUrl)) fail('coverUrl 变为 /covers/<id>.png?t=...', coverUrl)
  ok('GET /dashboards 里 coverUrl 已更新', coverUrl)
  const coverFetch = await fetch(`${BASE}${coverUrl}`)
  const coverBuf = Buffer.from(await coverFetch.arrayBuffer())
  if (coverFetch.status !== 200 || coverBuf[0] !== 0x89 || coverBuf[1] !== 0x50 || coverBuf[2] !== 0x4e || coverBuf[3] !== 0x47) {
    fail('GET coverUrl → 200 且是 PNG', `HTTP ${coverFetch.status}`)
  }
  ok('GET coverUrl → 200 且是 PNG', `${coverBuf.length} 字节`)
  const badCover = await api('POST', `/dashboards/${dash.id}/cover`, { image: 'data:image/png;base64,aGVsbG8gd29ybGQ=' })
  if (badCover.status !== 400) fail('垃圾封面 → 400', `HTTP ${badCover.status}`)
  ok('上传垃圾数据 → 400（大白话报错）', badCover.json?.error)

  // 8.10 导出代码：export → 200 + filename* + 内容与预览一致；不存在的版本 → 404
  const exportRes = await fetch(`${BASE}/api/v1/dashboards/${dash.id}/versions/${v1.id}/export`)
  const exportHtml = await exportRes.text()
  if (exportRes.status !== 200) fail('GET export → 200', `HTTP ${exportRes.status}`)
  if (!(exportRes.headers.get('content-type') ?? '').includes('text/html')) fail('export Content-Type 是 text/html', exportRes.headers.get('content-type'))
  const cd = exportRes.headers.get('content-disposition') ?? ''
  if (!cd.includes("filename*=UTF-8''")) fail('Content-Disposition 含 filename*', cd)
  if (
    !/id=["']dashboard-data["']/.test(exportHtml) ||
    !exportHtml.includes('88.8') ||
    /(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(exportHtml)
  ) {
    fail('导出 HTML 自包含真实数据且无外部资源')
  }
  ok('GET export → 200，Content-Disposition 含 filename*，真实数据已安全内联', cd)
  const export404 = await api('GET', `/dashboards/${dash.id}/versions/ver-not-exist/export`)
  if (export404.status !== 404) fail('导出不存在的版本 → 404', `HTTP ${export404.status}`)
  ok('导出不存在的版本 → 404')

  // 8.11 断源链路：数据源换成挂掉的 stub → 「数据源连不上」卡点卡 → 再试一次仍摆卡 → 改用演示数据照常出预览
  const downSource = { ...goodSource, url: `http://127.0.0.1:${MCP_DOWN_PORT}` }
  const putDown = await api('PUT', '/data-sources', [downSource])
  if (putDown.status !== 200) fail('PUT 断源配置', `HTTP ${putDown.status}`)
  const dash5 = (await api('POST', '/dashboards', { name: '断源演示大屏' })).json
  const sse5 = openSse(dash5.id)
  await api('POST', `/dashboards/${dash5.id}/messages`, { text: '做一个经营指标大屏' })
  const clar5 = await sse5.waitFor('message', (e) => e.data?.message?.kind === 'clarification', 60_000, '大屏5 澄清卡片')
  await api('POST', `/dashboards/${dash5.id}/messages/${clar5.data.message.id}/answers`, {
    answers: clar5.data.message.questions.map((q) => ({
      questionId: q.id,
      optionId: q.options.find((o) => o.recommended).id,
      customText: ''
    }))
  })
  const downCard = await sse5.waitFor(
    'message',
    (e) => e.data?.message?.kind === 'problem' && e.data?.message?.options?.some((o) => o.id === 'opt-demo-data'),
    90_000,
    '数据源连不上卡点卡'
  )
  if (downCard.data.message.title !== '数据源连不上') fail('卡点卡标题「数据源连不上」', downCard.data.message.title)
  const downOpts = downCard.data.message.options
  const downRec = downOpts.filter((o) => o.recommended)
  if (downOpts.length !== 3 || downRec.length !== 1 || downRec[0].id !== 'opt-demo-data') {
    fail('★推荐恰为「改用演示数据继续」且共三选项', JSON.stringify(downOpts))
  }
  for (const id of ['opt-demo-data', 'opt-retry-datasource', 'opt-assist']) {
    if (!downOpts.some((o) => o.id === id)) fail(`卡点卡含选项 ${id}`)
  }
  ok('断源 →「数据源连不上」卡点卡（★改用演示数据/再试一次/呼叫人工）')
  await api('POST', `/dashboards/${dash5.id}/options/opt-retry-datasource`)
  await sse5.waitFor(
    'message',
    (e) =>
      e.data?.message?.kind === 'problem' &&
      e.data?.message?.id !== downCard.data.message.id &&
      e.data?.message?.options?.some((o) => o.id === 'opt-demo-data'),
    90_000,
    '再试一次后再次摆卡'
  )
  ok('选「再试一次取数」→ 仍连不上 → 再次摆卡')
  await api('POST', `/dashboards/${dash5.id}/options/opt-demo-data`)
  const ready5 = await sse5.waitFor('previewReady', null, 90_000, '大屏5 previewReady')
  const html5 = await (await fetch(new URL(ready5.data.url, BASE))).text()
  if (html5.includes('88.8%')) fail('演示数据路径不烤真实数据')
  ok('选「改用演示数据继续」→ 预览照常 ready（演示数据）', ready5.data.url)
  sse5.close()

  // 9. 重启服务端（DATA_DIR 保留）：数据源配置恢复 + 数据快照落盘（含 88.8%、网址已剥除）+ 编辑复用快照不重取数
  const oldServer = serverProc
  await new Promise((resolve) => {
    oldServer.once('exit', resolve)
    oldServer.kill('SIGKILL')
  })
  serverProc = startProc('server-restart', process.execPath, [tsxCli, path.join(SERVER_DIR, 'src/index.ts')], serverEnv)
  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 30_000, '服务端重启')
  const dsAfterRestart = (await api('GET', '/data-sources')).json
  if (
    !Array.isArray(dsAfterRestart) ||
    dsAfterRestart.length !== 1 ||
    dsAfterRestart[0].url !== downSource.url ||
    dsAfterRestart[0].token !== MASKED_SECRET
  ) {
    fail('重启后数据源配置恢复', JSON.stringify(dsAfterRestart))
  }
  ok('重启服务端 → data-sources.json 配置恢复', dsAfterRestart[0].url)
  const persistedDataFile = path.join(DATA_DIR, 'previews', dash.id, v1.id, 'data.json')
  const persistedData = fs.readFileSync(persistedDataFile, 'utf8')
  if (!persistedData.includes('88.8')) fail('数据快照落盘且含真实数据', persistedData.slice(0, 120))
  if (/https?:\/\//.test(persistedData)) fail('数据快照落盘前已剥除网址', persistedData.slice(0, 200))
  ok('数据快照落盘：含 88.8 且网址已剥除', `${persistedData.length} 字符`)
  // 编辑流复用快照：数据源此刻仍指向挂掉的 stub，若重新取数必然摆卡；能出预览且含 88.8% 即证明沿用快照
  const sseR = openSse(dash.id)
  await api('POST', `/dashboards/${dash.id}/messages`, { text: '把标题改短一点' })
  const readyR = await sseR.waitFor('previewReady', null, 90_000, '重启后编辑 previewReady')
  const htmlR = await (await fetch(new URL(readyR.data.url, BASE))).text()
  const dataR = await (await fetch(new URL('./data.json', readyR.data.url))).text()
  if (!/fetch\(\s*["']\.\/data\.json["']\s*\)/.test(htmlR) || !dataR.includes('88.8')) {
    fail('编辑流沿用 data.json 数据快照（不重取数）')
  }
  ok('重启后编辑复用数据快照（不重取数）→ previewReady', readyR.data.url)
  sseR.close()

  // 10. Last-Event-ID 补发抽查
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
