/**
 * MCP 客户端 —— 零依赖极简实现，用全局 fetch 打 JSON-RPC 2.0。
 *
 * 只支持 Streamable HTTP 单端点传输：
 *   initialize 握手（记下 Mcp-Session-Id 响应头，后续请求带上）
 *   → notifications/initialized 通知
 *   → tools/list / tools/call
 * 请求头 Accept: application/json, text/event-stream；响应若是 SSE（text/event-stream）
 * 则逐行解析 data: 取最后一个 JSON-RPC 消息。
 *
 * 认证按 authType 组头：bearer → Authorization: Bearer <令牌>；
 * header → <headerName>: <值>；none → 不带；
 * hmac → 每请求按 METHOD\nPATH\nTIMESTAMP\nBODY 算 HMAC-SHA256，带 X-AK/X-Timestamp/X-Signature。
 * URL 只放行 http/https；错误一律大白话（detail 收技术细节）。
 */
import crypto from 'node:crypto'
import type { McpDataSource } from './wire'

/** MCP 调用失败时抛出的错误（message 为大白话，detail 收技术细节） */
export class McpError extends Error {
  detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.detail = detail
  }
}

export interface McpTool {
  name: string
  description?: string
  /** 参数说明（JSON Schema 原样保留，组装取数规划 prompt 的工具目录用） */
  inputSchema?: Record<string, unknown>
}

const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS) || 15_000
const TOOLS_CACHE_TTL_MS = 5 * 60_000

/* ------------------------------ tools/list 内存缓存 ------------------------------ */

interface ToolsCacheEntry {
  tools: McpTool[]
  expiresAt: number
}

const toolsCache = new Map<string, ToolsCacheEntry>()

/** 缓存键：连接字段变 → 视为另一个源（避免改了地址/令牌还命中旧缓存） */
function cacheKeyOf(source: McpDataSource): string {
  return JSON.stringify([source.url, source.authType, source.token, source.headerName, source.accessKey, source.secretKey])
}

/** 缓存失效：probe 成功或保存数据源列表时调用（不传 source 则全清） */
export function invalidateToolsCache(source?: McpDataSource): void {
  if (source) toolsCache.delete(cacheKeyOf(source))
  else toolsCache.clear()
}

/* ------------------------------ 基础 ------------------------------ */

function assertHttpUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new McpError('数据源地址格式不对，检查一下是不是完整的网址', `无法解析 URL：${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new McpError('数据源地址只支持 http 或 https 开头', `不允许的协议：${u.protocol}`)
  }
}

/** HMAC-SHA256 签名：用 SK 对签名串算，返回 hex。
 * 签名串 4 段 \n 拼接：METHOD\nPATH\nTIMESTAMP\nBODY（PATH 不含 query）。 */
function hmacSignature(secretKey: string, method: string, pathName: string, ts: string, body: string): string {
  const signStr = `${method}\n${pathName}\n${ts}\n${body}`
  return crypto.createHmac('sha256', secretKey).update(signStr, 'utf8').digest('hex')
}

/** 按认证方式组请求头。hmac 需要逐请求算签名，因此带 method/pathName/body 参数；其它认证方式忽略这些参数。
 * ts 由调用方在签名时一并生成（保证时间戳与签名严格对应、防重放）。 */
function authHeaders(source: McpDataSource, method: string, pathName: string, body: string): Record<string, string> {
  if (source.authType === 'bearer' && source.token) return { Authorization: `Bearer ${source.token}` }
  if (source.authType === 'header' && source.headerName && source.token) {
    return { [source.headerName]: source.token }
  }
  if (source.authType === 'hmac' && source.accessKey && source.secretKey) {
    const ts = Math.floor(Date.now() / 1000).toString()
    const sig = hmacSignature(source.secretKey, method, pathName, ts, body)
    return { 'X-AK': source.accessKey, 'X-Timestamp': ts, 'X-Signature': sig }
  }
  return {}
}

/** HTTP 状态码 → 大白话（对齐 gateway.ts hintForHttpError 风格） */
function hintForHttpError(status: number): string {
  if (status === 401 || status === 403) return '数据源拒绝了访问，检查令牌对不对'
  if (status === 404) return '数据源地址似乎不对（找不到这个服务）'
  if (status === 429) return '数据源太忙了，稍等片刻再试'
  if (status >= 500) return '数据源自己出了点问题，稍后再试'
  return '数据源返回了看不懂的回应'
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

/** 解析响应体：SSE 取最后一个 JSON-RPC 消息，否则按普通 JSON */
async function readJsonRpc(res: Response): Promise<JsonRpcMessage> {
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (contentType.includes('text/event-stream')) {
    let last: JsonRpcMessage | null = null
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        last = JSON.parse(line.slice(5).trim()) as JsonRpcMessage
      } catch {
        /* 跳过非 JSON 的 data 行 */
      }
    }
    if (last) return last
    throw new McpError('数据源返回了看不懂的回应', `SSE 流里没有 JSON-RPC 消息：${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text) as JsonRpcMessage
  } catch {
    throw new McpError('数据源返回了看不懂的回应', `响应不是 JSON：${text.slice(0, 300)}`)
  }
}

/* ------------------------------ 会话内一次请求 ------------------------------ */

async function post(source: McpDataSource, sessionId: string | null, body: unknown): Promise<JsonRpcMessage | null> {
  // ★ 只序列化一次 body：签名串里的 body 必须与实际发送的 body 逐字节一致
  const bodyStr = JSON.stringify(body)
  const pathName = new URL(source.url).pathname // 签名只取 pathname（不含 query）
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...authHeaders(source, 'POST', pathName, bodyStr),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
  }
  let res: Response
  try {
    res = await fetch(source.url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    })
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const isTimeout = err instanceof Error && /timeout|abort/i.test(err.message)
    throw new McpError(isTimeout ? '连不上数据源：等了很久都没有回应' : '连不上数据源：地址似乎不对或网络不通', `POST ${source.url} 失败。${detail}`)
  }
  if (!res.ok) {
    const snippet = await res.text().catch(() => '')
    throw new McpError(
      `连不上数据源：${hintForHttpError(res.status)}`,
      `POST ${source.url} 返回 HTTP ${res.status}。${snippet.slice(0, 300)}`
    )
  }
  // 通知类请求服务器可能回 202 无内容
  if (res.status === 202) return null
  const msg = await readJsonRpc(res)
  // initialize 的响应头里拿会话 id，顺着出口塞给调用方
  const sid = res.headers.get('mcp-session-id')
  if (sid) (msg as JsonRpcMessage & { __sessionId?: string }).__sessionId = sid
  return msg
}

function checkRpcError(msg: JsonRpcMessage | null, what: string): asserts msg is JsonRpcMessage {
  if (!msg) throw new McpError('数据源返回了看不懂的回应', `${what} 没有收到回应`)
  if (msg.error) {
    throw new McpError(`数据源拒绝了这次请求（${what}）`, `JSON-RPC 错误 ${msg.error.code ?? ''}: ${msg.error.message ?? ''}`)
  }
}

let nextId = 1

/** 建会话（initialize → notifications/initialized）后在会话里执行一个方法 */
async function withSession<T>(source: McpDataSource, method: string, params: unknown): Promise<T> {
  assertHttpUrl(source.url)
  const init = await post(source, null, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ai-dashboard', version: '1.0.0' }
    }
  })
  checkRpcError(init, '握手')
  const sessionId = (init as JsonRpcMessage & { __sessionId?: string }).__sessionId ?? null
  // 已初始化通知：失败不致命（有些实现不要求）
  await post(source, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})
  const reply = await post(source, sessionId, { jsonrpc: '2.0', id: nextId++, method, params })
  checkRpcError(reply, method)
  return reply.result as T
}

/* ------------------------------ 对外 API ------------------------------ */

interface ToolsListResult {
  tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
}

/** 列出数据源可用的取数工具（5 分钟内存缓存） */
export async function listTools(source: McpDataSource): Promise<McpTool[]> {
  const key = cacheKeyOf(source)
  const hit = toolsCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.tools
  const result = await withSession<ToolsListResult>(source, 'tools/list', {})
  const tools = (Array.isArray(result?.tools) ? result.tools : [])
    .filter((t): t is { name: string; description?: string; inputSchema?: unknown } => typeof t?.name === 'string' && t.name.length > 0)
    .map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {})
    }))
  toolsCache.set(key, { tools, expiresAt: Date.now() + TOOLS_CACHE_TTL_MS })
  return tools
}

interface CallToolResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

/** 调用一个取数工具，返回文本内容；失败重试 1 次 */
export async function callTool(source: McpDataSource, name: string, args: Record<string, unknown> = {}): Promise<string> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withSession<CallToolResult>(source, 'tools/call', { name, arguments: args })
      if (result?.isError) {
        const text = (result.content ?? []).map((c) => c.text ?? '').join('')
        throw new McpError(`数据源的工具「${name}」执行失败了`, text.slice(0, 300) || '工具返回 isError')
      }
      const parts = (result?.content ?? []).map((c) => c.text ?? '').filter(Boolean)
      if (parts.length > 0) return parts.join('\n')
      return JSON.stringify(result ?? {})
    } catch (err) {
      lastErr = err
      // 工具自身执行失败不重试（多半是参数问题）；连接类失败重试 1 次
      if (err instanceof McpError && err.message.includes('执行失败')) break
      if (attempt === 0) continue
    }
  }
  if (lastErr instanceof McpError) throw lastErr
  const detail = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr)
  throw new McpError('连不上数据源：出了点意外情况', `tools/call ${name} 失败（已重试 1 次）。${detail}`)
}
