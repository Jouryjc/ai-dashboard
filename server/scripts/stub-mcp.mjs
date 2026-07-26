#!/usr/bin/env node
/**
 * stub-mcp.mjs —— 假 MCP 数据源（Streamable HTTP 单端点），供冒烟无 Key 联调。
 *
 * 用法：node scripts/stub-mcp.mjs [port] [--down] [--token=xxx]
 *   默认端口 9200；--down 时所有请求一律 500（模拟数据源挂掉）；
 *   --token=xxx 时要求 Authorization: Bearer xxx，不符返回 401。
 *
 * 行为（单 POST 端点，按 JSON-RPC method 路由）：
 *   - initialize → 返回协议版本，响应头带 Mcp-Session-Id；之后的请求必须携带该头，否则 400
 *   - notifications/initialized → 202 无内容
 *   - tools/list → 以 SSE（text/event-stream）格式返回 get_metrics 工具（顺带演练客户端 SSE 解析）
 *   - tools/call → 固定经营指标 JSON：completionRate 为 "88.8%"（冒烟据此验证数据真烤进 HTML），
 *     另带一个 http(s) 网址字段（冒烟验证注入前会被剥掉）
 */
import http from 'node:http'

const args = process.argv.slice(2)
const DOWN = args.includes('--down')
const tokenArg = args.find((a) => a.startsWith('--token='))
const EXPECT_TOKEN = tokenArg ? tokenArg.slice('--token='.length) : (process.env.STUB_MCP_TOKEN ?? '')
const portArg = args.find((a) => /^\d+$/.test(a))
const PORT = Number(portArg ?? process.env.STUB_MCP_PORT ?? 9200)

const SESSION_ID = 'stub-mcp-session-1'

const TOOLS = [
  {
    name: 'get_metrics',
    description: '查经营指标',
    inputSchema: {
      type: 'object',
      properties: { month: { type: 'string', description: '月份，如 2026-07' } }
    }
  }
]

const METRICS = {
  period: '2026-07',
  completionRate: '88.8%',
  onlineDevices: 1024,
  avgResponseMs: 36,
  alarms: 7,
  reportUrl: 'https://stub-mcp.example.com/reports/2026-07'
}

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'only POST' }))
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (DOWN) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'stub mcp is down' }))
      return
    }
    if (EXPECT_TOKEN && req.headers.authorization !== `Bearer ${EXPECT_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad token' }))
      return
    }
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad json' }))
      return
    }
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION_ID })
      res.end(
        rpcResult(msg.id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-mcp', version: '1.0.0' }
        })
      )
      return
    }
    // 握手之后的请求必须携带会话 id（校验客户端有没有顺着 Mcp-Session-Id 头带回来）
    if (req.headers['mcp-session-id'] !== SESSION_ID) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing Mcp-Session-Id' }))
      return
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    if (msg.method === 'tools/list') {
      // 用 SSE 格式回包，演练客户端的 data: 行解析
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${rpcResult(msg.id, { tools: TOOLS })}\n\n`)
      return
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name !== 'get_metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(rpcResult(msg.id, { content: [{ type: 'text', text: `没有叫「${msg.params?.name}」的工具` }], isError: true }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(METRICS, null, 2) }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `不认识的方法：${msg.method}` } }))
  })
})

server.listen(PORT, () => {
  console.log(`stub-mcp 已启动: http://127.0.0.1:${PORT} (down: ${DOWN ? 'on' : 'off'}, token: ${EXPECT_TOKEN ? 'on' : 'off'})`)
})
