#!/usr/bin/env node
/**
 * stub-llm.mjs —— OpenAI 兼容的假模型，供无 Key 环境联调。
 *
 * 用法：node scripts/stub-llm.mjs [port] [--no-vision]
 *   默认端口 9100；--no-vision 时带 image_url 的请求返回 400（模拟不支持看图的模型）。
 *
 * 行为：
 *   - max_tokens=1 的最小请求（probe）→ 正常返回
 *   - 带 image_url 的请求 + planner 提示词 → 返回"图片分析"规划 JSON
 *   - system 含「大屏规划师」→ 返回规划 JSON（分析结论 + 2 个澄清问题，恰一个 ★推荐）
 *   - system 含「取数规划师」→ 从工具目录抓第一个数据源 + 第一个工具，规划一条调用（目录空则空 calls）
 *   - system 含「大屏开发」→ 返回一段合法的自包含大屏 HTML（>2KB，无外部引用）；
 *     user 文本含「以下是从数据源取回的真实数据」时把特征数值 88.8% 回声进页面（验证 MCP 数据烤进 HTML）
 *   - system 含「大屏读图精读专家」→ 返回一份固定的参考图内容清单 JSON（无地图，避免联网备料）
 *   - system 含「大屏验收员」→ 返回截图审查 JSON：需求文本带「演示视觉修复」时
 *     同一需求首次报一个问题（之后的复查放行），否则空清单
 */
import http from 'node:http'

const args = process.argv.slice(2)
const noVision = args.includes('--no-vision')
const portArg = args.find((a) => /^\d+$/.test(a))
const PORT = Number(portArg ?? process.env.STUB_PORT ?? 9100)

// 截图审查已报过问题的需求文本（同一需求只在首次审查时报问题，复查放行，模拟"修好了"）
const shotReviewReported = new Set()

function reply(content) {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'stub-1',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  }
}

function plannerJson(hasImage) {
  return JSON.stringify({
    analysis: hasImage
      ? '整体是深色科技风，中间是主视觉区，两侧排着指标卡和排行榜。我按这个骨架来做。'
      : '你要的是一个监控类大屏，重点看几个核心指标的走势和当前状态，我用深色科技风来做，一块屏看全。',
    needClarification: true,
    intro: '开始之前，想跟你确认两件事',
    questions: [
      {
        question: '重点关注哪些指标？',
        options: [
          {
            title: '最常用的三样都要',
            consequence: '一块屏全看到，不用来回切换',
            recommended: true,
            recommendReason: '这个组合选的人最多，一次到位'
          },
          { title: '只要核心指标', consequence: '界面更简洁，其他指标不展示', recommended: false }
        ]
      },
      {
        question: '数据多久自动刷新一次？',
        options: [
          { title: '每 5 秒', consequence: '接近实时，适合盯告警', recommended: true, recommendReason: '监控场景选得最多' },
          { title: '每分钟', consequence: '更省资源，适合长期挂屏', recommended: false }
        ]
      }
    ]
  })
}

function skeletonHtml() {
  // 带两个 PANEL 占位注释的骨架（>2KB，无外部引用）
  const pad = '/* 骨架样式 */\n'.repeat(120)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>骨架</title>
<style>
${pad}
html, body { width: 1920px; height: 1080px; overflow: hidden; background: #070d1f; color: #dbe4ff; margin: 0; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 24px; height: 100%; box-sizing: border-box; }
.panel { background: rgba(20,32,66,.9); border: 1px solid rgba(80,120,255,.22); border-radius: 12px; padding: 16px; }
</style>
</head>
<body>
<main>
<!--PANEL:核心指标-->
<!--PANEL:趋势图表-->
</main>
</body>
</html>`
}

function dashboardHtml(userText) {
  const title = (userText.match(/请做这样一个大屏：([^\n]+)/)?.[1] ?? '数据大屏').slice(0, 30)
  // 联调标记：用户需求含「演示视觉修复」时埋一个视觉问题，供「视觉检查 → 修复问题」链路演练；
  // 修复请求（含"检查没通过"）返回干净 HTML，模拟修复成功
  const marker = userText.includes('演示视觉修复') && !userText.includes('检查没通过')
    ? '<!-- STUB_VISUAL_ISSUE -->'
    : ''
  // 真实数据标记：user 文本含「以下是从数据源取回的真实数据」说明编排层注入了取数快照
  // （标记文本与 loop-adapter/shared-utils.ts 的 DATA_BLOCK_HEADER 头部一致），
  // 把特征数值 88.8% 回声进页面，冒烟据此验证 MCP 数据真的烤进了 HTML
  const dataKpi = userText.includes('以下是从数据源取回的真实数据')
    ? '<div class="kpi">88.8%<small>目标完成率（真实数据）</small></div>\n      '
    : ''
  // 用重复的内联柱图把内容撑到 2KB 以上，全程无外部引用
  const bars = Array.from({ length: 12 }, (_, i) => {
    const h = 60 + ((i * 37) % 120)
    return `<rect x="${80 + i * 60}" y="${300 - h}" width="34" height="${h}" rx="4" fill="url(#g1)"><title>第${i + 1}项：${h}</title></rect>`
  }).join('\n      ')
  const points = Array.from({ length: 24 }, (_, i) => `${60 + i * 40},${180 - ((i * 53) % 110)}`).join(' ')
  return `<!DOCTYPE html>
${marker}<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; }
  body { background: radial-gradient(ellipse at 50% -20%, #12204a 0%, #070d1f 55%, #050a18 100%); color: #dbe4ff; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; }
  header { height: 84px; display: flex; align-items: center; justify-content: space-between; padding: 0 36px; border-bottom: 1px solid rgba(46,91,255,.35); background: linear-gradient(90deg, rgba(46,91,255,.14), rgba(34,211,238,.05), rgba(46,91,255,.14)); }
  header h1 { font-size: 30px; letter-spacing: 4px; background: linear-gradient(90deg,#7ea2ff,#22d3ee); -webkit-background-clip: text; background-clip: text; color: transparent; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 18px; padding: 18px 24px 24px; }
  .panel { background: linear-gradient(160deg, rgba(20,32,66,.92), rgba(10,17,38,.92)); border: 1px solid rgba(80,120,255,.22); border-radius: 12px; padding: 16px 18px; }
  .panel h2 { font-size: 16px; color: #8ea0c9; margin-bottom: 12px; }
  .kpi { font-size: 44px; font-weight: 700; color: #22d3ee; margin: 10px 0; }
  .kpi small { font-size: 14px; color: #8ea0c9; display: block; margin-top: 6px; }
  .row { display: flex; justify-content: space-between; padding: 10px 4px; border-bottom: 1px dashed rgba(80,120,255,.18); font-size: 15px; }
  .row b { color: #7ea2ff; }
  footer { height: 40px; text-align: center; color: #5a6b96; font-size: 13px; line-height: 40px; }
</style>
</head>
<body>
  <header><h1>${title}</h1><div>演示数据 · 每 5 秒刷新</div></header>
  <main>
    <section class="panel">
      <h2>核心指标</h2>
      ${dataKpi}<div class="kpi">98.2%<small>正常运行率</small></div>
      <div class="kpi">1,024<small>当前在线</small></div>
      <div class="kpi">36ms<small>平均响应</small></div>
      <div class="kpi">7<small>待处理告警</small></div>
    </section>
    <section class="panel">
      <h2>趋势与分布</h2>
      <svg viewBox="0 0 900 340" width="100%" height="360">
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2e5bff"/><stop offset="1" stop-color="#22d3ee"/>
          </linearGradient>
        </defs>
        ${bars}
        <polyline points="${points}" fill="none" stroke="#22d3ee" stroke-width="3" stroke-linejoin="round" transform="translate(0,300) scale(1,-0.6)"/>
      </svg>
    </section>
    <section class="panel">
      <h2>排行</h2>
      <div class="row"><span>华东节点</span><b>99.1%</b></div>
      <div class="row"><span>华北节点</span><b>98.7%</b></div>
      <div class="row"><span>华南节点</span><b>98.4%</b></div>
      <div class="row"><span>西南节点</span><b>97.9%</b></div>
      <div class="row"><span>西北节点</span><b>97.2%</b></div>
      <div class="row"><span>东北节点</span><b>96.8%</b></div>
    </section>
  </main>
  <footer>本页面为完整自包含文件，未引用任何外部资源 · 1920×1080</footer>
  <script>
    // 纯演示：让 KPI 数字轻微跳动，模拟实时刷新
    setInterval(() => {
      document.querySelectorAll('.kpi').forEach((el) => {
        const n = el.childNodes[0]
        if (n && /^[\\d.,%ms]+/.test(n.textContent)) {
          const num = parseFloat(n.textContent.replace(/[^\\d.]/g, ''))
          if (!Number.isNaN(num)) n.textContent = n.textContent.replace(/[\\d.]+/, (num * (1 + (Math.random() - 0.5) / 50)).toFixed(n.textContent.includes('.') ? 1 : 0))
        }
      })
    }, 5000)
  </script>
</body>
</html>`
}

function hasImage(messages) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === 'image_url')
  )
}

function systemText(messages) {
  const sys = messages.find((m) => m.role === 'system')
  return typeof sys?.content === 'string' ? sys.content : ''
}

function userText(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  if (!user) return ''
  if (typeof user.content === 'string') return user.content
  return user.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.replace(/\/+$/, '').endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad json' } }))
        return
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const image = hasImage(messages)
      if (image && noVision) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'this model does not support image input' } }))
        return
      }
      const sys = systemText(messages)
      // 慢编码标记：人为拖延 6 秒，用于演练"执行超时 → 拆分步骤"
      if (sys.includes('大屏开发') && userText(messages).includes('SLOWCODER') && !userText(messages).includes('占位注释') && !userText(messages).includes('只写「')) {
        await new Promise((r) => setTimeout(r, 6000))
      }
      let content
      if (payload.max_tokens === 1) {
        content = image ? '一个小点。' : 'ok'
      } else if (sys.includes('大屏规划师')) {
        content = plannerJson(image)
      } else if (sys.includes('模板匹配师')) {
        // 模板匹配：默认命中 U 型布局 + 3 类组件；文本含「完全自定义需求」时模拟匹配不上
        content = userText(messages).includes('完全自定义需求')
          ? JSON.stringify({ layoutId: null, layoutReason: '', componentIds: [], unmatched: ['特殊的 3D 地球主视觉'] })
          : JSON.stringify({
              layoutId: 'layoutU',
              layoutReason: '中央放主视觉、四周环绕指标面板，最适合监控类大屏',
              componentIds: ['bar_charts', 'numerical_indicators', 'line_charts'],
              unmatched: []
            })
      } else if (sys.includes('取数规划师')) {
        // 取数规划：从工具目录里抓第一个数据源 + 第一个工具，规划一条调用；目录里没有工具就空 calls
        const ut = userText(messages)
        const sourceId = ut.match(/（sourceId：([^）]+)）/)?.[1] ?? ''
        const tool = ut.match(/\n- ([^：\s]+)/)?.[1] ?? ''
        content =
          sourceId && tool
            ? JSON.stringify({ calls: [{ sourceId, tool, args: {}, purpose: '大屏要展示的核心指标' }] })
            : JSON.stringify({ calls: [] })
      } else if (sys.includes('大屏读图精读专家')) {
        // 参考图精读：返回一份固定的内容清单 JSON（hasMap=false，避免触发联网地图备料）
        content = JSON.stringify({
          title: '生产经营监控大屏',
          layout: '顶部标题条 + 左右两列面板 + 中央主视觉',
          panels: [
            { name: '核心指标', position: '左列上方', content: '4 个 KPI 数字卡' },
            { name: '趋势分析', position: '左列下方', content: '折线图' },
            { name: '排行', position: '右列', content: '条形排行' }
          ],
          kpis: ['98.2% 正常运行率', '1,024 当前在线'],
          colors: '深蓝底 + 青色高亮',
          hasMap: false,
          mapAdcode: '',
          mapCities: [],
          notes: '冒烟固定清单'
        })
      } else if (sys.includes('大屏验收员')) {
        // 截图审查：需求文本带「演示视觉修复」时同一需求首次报一个问题（修复后复查放行），否则空清单
        const ut = userText(messages)
        if (ut.includes('演示视觉修复') && !shotReviewReported.has(ut)) {
          shotReviewReported.add(ut)
          content = JSON.stringify({ issues: [{ title: '表格内容可能超出屏幕边界', detail: '给表格区域加上自动换行，并把总宽度收窄到画面内' }] })
        } else {
          content = JSON.stringify({ issues: [] })
        }
      } else if (sys.includes('布局检查员')) {
        // 视觉检查：HTML 里埋了 STUB_VISUAL_ISSUE 标记才报一个问题，否则放行
        content = userText(messages).includes('STUB_VISUAL_ISSUE')
          ? JSON.stringify({ issues: [{ title: '表格内容可能超出屏幕边界', detail: '给表格区域加上自动换行，并把总宽度收窄到画面内' }] })
          : JSON.stringify({ issues: [] })
      } else if (sys.includes('大屏开发') && userText(messages).includes('占位注释')) {
        // 拆分步骤第 1 步：骨架（带 PANEL 占位注释）
        content = skeletonHtml()
      } else if (sys.includes('大屏开发') && userText(messages).includes('只写「')) {
        // 拆分步骤第 2..N 步：单个面板片段（标题带面板名，模拟按名生成）
        const panelName = userText(messages).match(/只写「([^」]+)」/)?.[1] ?? '面板'
        content = `<div class="panel"><h2>${panelName}</h2><div style="font-size:40px;color:#22d3ee">88.6%</div><svg viewBox="0 0 200 60"><polyline points="0,50 40,30 80,40 120,15 160,25 200,8" fill="none" stroke="#22d3ee" stroke-width="2"/></svg></div>`
      } else if (sys.includes('大屏开发')) {
        content = dashboardHtml(userText(messages))
      } else {
        content = '好的。'
      }
      // 流式请求：按 SSE 分块吐出（每块 ~24 字），验证客户端/网关的流式解析
      if (payload.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        const chunks = content.match(/[\s\S]{1,24}/g) ?? []
        for (const c of chunks) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply(content)))
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})

server.listen(PORT, () => {
  console.log(`stub-llm 已启动: http://127.0.0.1:${PORT}/v1 (vision: ${noVision ? 'off' : 'on'})`)
})
