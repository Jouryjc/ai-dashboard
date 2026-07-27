/**
 * 模型网关（Model Gateway）-- 所有 LLM 调用的唯一入口。
 *
 * - OpenAI 兼容 chat/completions 协议，Bearer Key
 * - 超时：planner 60s / coder 600s；网络错误与 5xx 重试 1 次
 * - probe(settings)：真实探测（最小 chat 请求验证连通；1×1 像素 base64 PNG
 *   的 image_url 请求验证 vision），文案一律大白话，细节收 detail
 * - extractJson / extractHtml：从 LLM 回复中容错提取（```json 包裹、首尾杂质）
 * - 思考型模型（kimi-k2、deepseek-r1 等）兼容：思考过程走 reasoning_content，
 *   正文走 content；流式时两者都计入"已生成字数"进度，但最终返回只用 content
 *   （思考过程是推理链路，不是结构化答案），content 为空才兜底 reasoning_content。
 */
import type { ModelSettings, ProbeResult } from './wire'

/** OpenAI 兼容消息（content 可能是多模态数组） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
}

export type AgentRole = 'planner' | 'coder' | 'vision'

/** 角色超时（SYSTEM_DESIGN §3.2 resilience 的落地值） */
const TIMEOUTS: Record<AgentRole, number> = {
  planner: 60_000,
  coder: 600_000, // 大屏 HTML 较长，慢模型（本地小参数）可能需要数分钟
  vision: 60_000
}

/** 1×1 像素 PNG（vision 探针用） */
export const PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 一次调用的实际目标（角色字段留空 = 跟随主设置） */
export interface ResolvedTarget {
  apiBase: string
  apiKey: string
  model: string
}

/**
 * 按角色解析实际调用目标：角色的 地址/Key/模型 任一留空就跟随主设置，
 * 三个都填了就是完全独立的一套（不同功能模型可以挂在不同服务商下）。
 */
export function resolveFor(settings: ModelSettings, role: AgentRole): ResolvedTarget {
  const cfg = settings[role]
  return {
    apiBase: cfg?.apiBase?.trim() || settings.apiBase,
    apiKey: cfg?.apiKey?.trim() || settings.apiKey,
    model: cfg?.model?.trim() || settings.model
  }
}

function chatUrl(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, '')
  // 用户可能粘贴完整端点 URL（…/v1/chat/completions），别再拼一次
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

/** 网关调用失败时抛出的错误（message 为大白话，detail 收技术细节） */
export class GatewayError extends Error {
  detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.detail = detail
  }
}

interface ChatOptions {
  role: AgentRole
  messages: LlmMessage[]
  maxTokens?: number
  temperature?: number
  /** 外部中止信号（20 分钟看门狗拆分任务时中断当前调用） */
  signal?: AbortSignal
}

interface RawChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type: string; text?: string }>
      // 思考型模型（kimi-k2、deepseek-r1 等）正文可能为空，思考过程在此字段
      reasoning_content?: string
    }
  }>
}

/** 非流式响应里单个 message 的形态（从 RawChatResponse 派生） */
type RawMessage = NonNullable<NonNullable<RawChatResponse['choices']>[number]['message']>

/**
 * 从非流式响应的 message 里提取正文：优先 content，兜底 reasoning_content。
 * 思考型模型部分端点不单独输出正文，思考过程即全部输出。
 */
function pickMessageContent(msg: RawMessage | undefined): string {
  if (!msg) return ''
  if (typeof msg.content === 'string' && msg.content) return msg.content
  if (Array.isArray(msg.content)) {
    const joined = msg.content.map((c: { type: string; text?: string }) => c.text ?? '').join('')
    if (joined) return joined
  }
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) return msg.reasoning_content
  return ''
}

/**
 * 剥离消息里的图片（image_url），只留文本。用于"图发给了不支持图片的模型"时降级重试：
 * 例如 vision 探测基于主模型(kimi 支持图)，但 Coder 实际用 glm-5.2(不支持图)，
 * 模板截图塞给 glm 会 400 "Model only support text input" -- 剥掉图重试，至少能出 HTML。
 * 返回 true 表示确实剥掉了图片（值得重试）。
 */
function stripImagesFromPayload(payload: Record<string, unknown>): boolean {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let stripped = false
  for (const msg of messages) {
    if (msg && typeof msg === 'object' && 'content' in msg) {
      const m = msg as { content: unknown }
      if (Array.isArray(m.content)) {
        const textParts = m.content.filter(
          (c): c is { type: 'text'; text: string } =>
            typeof c === 'object' && c !== null && (c as { type: string }).type === 'text'
        )
        if (textParts.length < m.content.length) {
          // 有非 text 部分（图片）被滤掉 -> 退化成纯文本（拼接或单条）
          m.content = textParts.length === 1 ? textParts[0].text : textParts.map((t) => t.text).join('\n')
          stripped = true
        }
      }
    }
  }
  return stripped
}

/**
 * HTTP 错误 -> 大白话提示。优先读服务商返回的 error.code/type（比状态码准）：
 * insufficient_quota 是"额度用完"不是"Key 无效"（阿里 MaaS 免费额度耗尽返回 403 + 此 code）。
 */
function hintForHttpError(status: number, snippet: string): string {
  let code = ''
  let providerMsg = ''
  try {
    const j = JSON.parse(snippet) as { error?: { code?: string; type?: string; message?: string } }
    code = `${j.error?.code ?? ''} ${j.error?.type ?? ''}`.toLowerCase()
    providerMsg = j.error?.message ?? ''
  } catch {
    /* 非 JSON 错误体 */
  }
  if (/quota|insufficient|balance|欠费|额度/.test(code)) {
    return '模型额度用完了，请到服务商控制台充值或调整额度设置'
  }
  if (/rate.?limit|too many|throttl/.test(code) || status === 429) {
    return '请求太频繁，稍等片刻再试'
  }
  if (status === 401 || status === 403) return 'Key 似乎无效或没有权限'
  if (status === 404) return '地址似乎不对（找不到这个接口）'
  if (/model|模型/.test(code) && /not.?found|不存在|未开通/.test(providerMsg)) {
    return '这个模型名不存在或没有开通，请检查模型设置'
  }
  return '模型服务拒绝了请求'
}

/**
 * 发起一次 chat/completions 调用。
 * 网络错误与 5xx 重试 1 次；4xx 不重试（多半是地址/Key/参数问题）。
 */
export async function chatCompletion(settings: ModelSettings, opts: ChatOptions): Promise<string> {
  const target = resolveFor(settings, opts.role)
  const url = chatUrl(target.apiBase)
  const model = target.model
  const timeoutMs = TIMEOUTS[opts.role]
  const payload: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    // 思考型模型（kimi-k2、deepseek-r1 等）在结构化任务（Planner 要 JSON、Coder 要 HTML）上
    // 思考过程无价值且极慢（实测 Planner 思考 80s+ 触发 60s 超时）。关闭 thinking：
    // 火山方舟/豆包系用 thinking:{type:"disabled"}；不支持该参数的模型会在 400 里报错，
    // 由下方 droppedThinking 降级去掉该参数重试，不占用重试额度。
    thinking: { type: 'disabled' },
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {})
  }

  let lastErr: unknown = null
  let droppedTemp = false
  let droppedThinking = false
  let droppedImages = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])])
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const snippet = text.slice(0, 500)
        // 思考型模型可能锁定 temperature：去掉该参数重试，不占用重试额度
        if (res.status === 400 && /temperature/i.test(snippet) && !droppedTemp) {
          droppedTemp = true
          delete payload.temperature
          attempt--
          continue
        }
        // 不支持 thinking 参数的模型：去掉该参数重试，不占用重试额度
        if (res.status === 400 && /thinking/i.test(snippet) && !droppedThinking) {
          droppedThinking = true
          delete payload.thinking
          attempt--
          continue
        }
        // 图发给了不支持图片的模型：剥离 image_url 重试，不占用重试额度
        if (
          res.status === 400 &&
          /only support text input|not support.*image|image.*not support|不支持.*图/i.test(snippet) &&
          !droppedImages &&
          stripImagesFromPayload(payload)
        ) {
          droppedImages = true
          attempt--
          continue
        }
        if (res.status >= 500 && attempt === 0) {
          lastErr = new Error(`HTTP ${res.status}: ${snippet}`)
          continue
        }
        throw new GatewayError(
          `连不上：${hintForHttpError(res.status, snippet)}`,
          `POST ${url} 返回 HTTP ${res.status}。${snippet}`
        )
      }
      const data = (await res.json()) as RawChatResponse
      const content = pickMessageContent(data.choices?.[0]?.message)
      if (content) return content
      throw new GatewayError('AI 这次没说出内容', `POST ${url} 返回里没有 choices[0].message.content`)
    } catch (err) {
      if (err instanceof GatewayError) throw err
      lastErr = err
      // 网络错误 / 超时：重试一次
      if (attempt === 0) continue
    }
  }
  const detail = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr)
  const isTimeout = lastErr instanceof Error && /timeout|abort/i.test(lastErr.message)
  throw new GatewayError(
    isTimeout ? '连不上：等了很久都没有回应（超时）' : '连不上：地址似乎不对或网络不通',
    `POST ${url} 失败（已重试 1 次）。${detail}`
  )
}

/**
 * 流式 chat/completions：SSE 逐块接收，onProgress 实时汇报已生成字数
 * （驱动客户端阶段时间线的"实时日志流"，长任务不再是黑盒转圈）。
 * 模型服务忽略 stream 参数时自动退化为普通 JSON 响应。
 */
export async function chatCompletionStream(
  settings: ModelSettings,
  opts: ChatOptions,
  onProgress: (chars: number, partial: string) => void
): Promise<string> {
  const target = resolveFor(settings, opts.role)
  const url = chatUrl(target.apiBase)
  const model = target.model
  const timeoutMs = TIMEOUTS[opts.role]
  const payload: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    stream: true,
    // 关闭思考型模型的思考过程（同 chatCompletion，详见其注释）
    thinking: { type: 'disabled' },
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {})
  }

  let lastErr: unknown = null
  let droppedTemp = false
  let droppedThinking = false
  let droppedImages = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])])
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const snippet = text.slice(0, 500)
        // 思考型模型可能锁定 temperature：去掉该参数重试，不占用重试额度
        if (res.status === 400 && /temperature/i.test(snippet) && !droppedTemp) {
          droppedTemp = true
          delete payload.temperature
          attempt--
          continue
        }
        // 不支持 thinking 参数的模型：去掉该参数重试，不占用重试额度
        if (res.status === 400 && /thinking/i.test(snippet) && !droppedThinking) {
          droppedThinking = true
          delete payload.thinking
          attempt--
          continue
        }
        // 图发给了不支持图片的模型（如 Coder 用 glm-5.2，但 vision 探测基于主模型带了图）：
        // 剥离消息里的 image_url 重试，不占用重试额度
        if (
          res.status === 400 &&
          /only support text input|not support.*image|image.*not support|不支持.*图/i.test(snippet) &&
          !droppedImages &&
          stripImagesFromPayload(payload)
        ) {
          droppedImages = true
          attempt--
          continue
        }
        if (res.status >= 500 && attempt === 0) {
          lastErr = new Error(`HTTP ${res.status}: ${snippet}`)
          continue
        }
        throw new GatewayError(
          `连不上：${hintForHttpError(res.status, snippet)}`,
          `POST ${url} 返回 HTTP ${res.status}。${snippet}`
        )
      }

      // 退化为普通 JSON 响应（模型服务不支持/忽略 stream）
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await res.json()) as RawChatResponse
        const content = pickMessageContent(data.choices?.[0]?.message)
        if (content) return content
        throw new GatewayError('AI 这次没说出内容', `POST ${url} 返回里没有 choices[0].message.content`)
      }

      // 解析 SSE 流
      if (!res.body) throw new GatewayError('连不上：响应没有内容', `POST ${url} body 为空`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      // 思考型模型：正文 content 与思考过程 reasoning_content 分开累计。
      // 进度汇报用两者之和（让用户看到在动，不卡"正在等大模型开口"）；
      // 最终返回只用 content（结构化答案），content 为空才兜底 reasoning_content。
      let content = ''
      let reasoning = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: string; reasoning_content?: string }
                  message?: { content?: string; reasoning_content?: string }
                }>
              }
              const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message
              if (typeof d?.content === 'string' && d.content) content += d.content
              if (typeof d?.reasoning_content === 'string' && d.reasoning_content) reasoning += d.reasoning_content
              const total = content + reasoning
              if (total) onProgress(total.length, total)
            } catch {
              /* 半包/保活帧，忽略 */
            }
          }
        }
      }
      if (content) return content
      // content 全程为空（部分端点思考型模型不单独输出正文）-> 兜底用思考过程，至少不报"没说出内容"
      if (reasoning) return reasoning
      throw new GatewayError('AI 这次没说出内容', `POST ${url} 流式响应结束但没有任何内容`)
    } catch (err) {
      if (err instanceof GatewayError) throw err
      lastErr = err
      if (attempt === 0) continue
    }
  }
  const detail = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr)
  const isTimeout = lastErr instanceof Error && /timeout|abort/i.test(lastErr.message)
  throw new GatewayError(
    isTimeout ? '连不上：等了很久都没有回应（超时）' : '连不上：地址似乎不对或网络不通',
    `POST ${url} 失败（已重试 1 次）。${detail}`
  )
}

/* ------------------------------ 探测（/probe） ------------------------------ */

/**
 * 真实探测：永远不抛错，结果体现在 ProbeResult。
 * 1) 最小 chat 请求（max_tokens=1）验证连通
 * 2) 1×1 像素图片的 image_url 请求验证 vision，不支持则 supportsVision=false
 */
export async function probe(settings: ModelSettings): Promise<ProbeResult> {
  if (!settings.apiBase?.trim() || !settings.apiKey?.trim()) {
    return {
      ok: false,
      supportsVision: false,
      message: '连不上：地址或 Key 还没填，请到设置里补全',
      detail: 'apiBase 或 apiKey 为空。'
    }
  }
  // 第一步：连通性（测主设置本身--顶栏状态和提示文案都指主模型；角色独立配置在实际调用时解析）
  const EMPTY_ROLE = { model: '', apiBase: '', apiKey: '' }
  try {
    await chatCompletion({ ...settings, planner: EMPTY_ROLE, coder: EMPTY_ROLE, vision: EMPTY_ROLE }, {
      role: 'planner',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16
    })
  } catch (err) {
    // 端点返回 200 但内容为空（思考型模型小 token 预算下的正常表现）= 连接没问题
    if (err instanceof GatewayError && err.message.includes('没说出内容')) {
      // 视为连通，继续 vision 探测
    } else {
      const extra = err instanceof GatewayError ? err.detail : ''
      const message =
        err instanceof GatewayError && err.message.startsWith('连不上')
          ? err.message
          : '连不上：地址似乎不对或 Key 无效'
      const detail = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        supportsVision: false,
        message,
        detail: `${detail}${extra ? `\n${extra}` : ''}\n常见原因：地址拼错、电脑不在公司内网或未连 VPN、Key 已过期、模型额度用完。`
      }
    }
  }
  // 第二步：vision 能力
  const vision = await probeVision(settings)
  if (vision.ok) {
    return {
      ok: true,
      supportsVision: true,
      message: '连接成功，支持图片理解，所有功能可用',
      detail: null
    }
  }
  return {
    ok: true,
    supportsVision: false,
    message: '连接成功。当前模型不支持看图片，布局检查将改用结构化检测，设计稿上传不可用',
    detail: `图片理解探测未通过：${vision.detail}`
  }
}

/**
 * vision 探测（独立实现，容错三条已知歧路）：
 * 1) max_tokens=16 而非 1 -- omni/思考型模型在 1 个 token 预算下可能返回空内容，空 ≠ 不支持；
 * 2) 端点明确报错才判"不支持"（4xx / error 字段）；HTTP 200 即使内容为空也算支持--
 *    服务方没有拒绝图片输入；
 * 3) 报"only support stream"类错误自动改用流式重试（qwen omni 部分端点只支持流式）。
 */
async function probeVision(settings: ModelSettings): Promise<{ ok: boolean; detail?: string }> {
  // 视觉角色可能有独立的地址/Key（如视觉模型挂在另一个服务商），探测必须走同一套配置
  const target = resolveFor(settings, 'vision')
  const url = chatUrl(target.apiBase)
  const model = target.model
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图里有什么？一句话回答。' },
        { type: 'image_url', image_url: { url: PIXEL_PNG_DATA_URL } }
      ]
    }
  ]

  const attempt = async (stream: boolean): Promise<{ status: number; bodyText: string }> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`
      },
      body: JSON.stringify({ model, messages, max_tokens: 16, stream }),
      signal: AbortSignal.timeout(TIMEOUTS.vision)
    })
    return { status: res.status, bodyText: await res.text().catch(() => '') }
  }

  try {
    let { status, bodyText } = await attempt(false)
    // 只支持流式的端点：换流式再试一次
    if (status === 400 && /stream/i.test(bodyText)) {
      ;({ status, bodyText } = await attempt(true))
    }
    if (status >= 400) {
      return { ok: false, detail: `HTTP ${status}：${bodyText.slice(0, 400)}` }
    }
    // 200：检查有没有 error 字段（部分网关 200 包错误）
    if (/"error"\s*:/.test(bodyText.slice(0, 2000)) && !/"choices"\s*:/.test(bodyText)) {
      return { ok: false, detail: bodyText.slice(0, 400) }
    }
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { ok: false, detail: `请求失败：${detail}` }
  }
}

/* ------------------------------ 输出容错提取 ------------------------------ */

/**
 * 从 LLM 回复中提取 JSON 对象：容忍 ```json 包裹、首尾杂质文字。
 * 找不到或解析失败时抛 GatewayError。
 */
export function extractJson(text: string): unknown {
  let t = text.trim()
  // 去掉 markdown 代码围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  // 截取第一个 { 到最后一个 }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new GatewayError('AI 的回答格式不对', `期望 JSON，实际返回：${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch (err) {
    throw new GatewayError(
      'AI 的回答格式不对',
      `JSON 解析失败：${err instanceof Error ? err.message : String(err)}。原文：${t.slice(0, 300)}`
    )
  }
}

/**
 * 从 LLM 回复中提取完整 HTML：容忍 ```html 包裹、前后解释文字。
 */
export function extractHtml(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  // 从 <!DOCTYPE 或 <html 开始截取
  const docIdx = t.search(/<!DOCTYPE/i)
  const htmlIdx = t.search(/<html[\s>]/i)
  const start = docIdx >= 0 ? docIdx : htmlIdx
  if (start > 0) t = t.slice(start)
  const end = t.search(/<\/html>/i)
  if (end >= 0) t = t.slice(0, end + '</html>'.length)
  return t.trim()
}
