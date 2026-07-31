/**
 * 执行器共享类型 -- 大屏节点执行器的公共依赖和产出约定。
 */
import type { ModelSettings } from '../wire'
import type { McpDataSource, DataUseEntry } from '../wire'

/** 执行器持有的 LLM 网关能力（包装 gateway） */
export interface LlmAdapter {
  chatStream(
    role: 'planner' | 'coder' | 'vision',
    messages: Array<{ role: 'system' | 'user'; content: string | unknown[] }>,
    onProgress: (chars: number, partial: string) => void,
    opts?: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string>
  extractJson(text: string): unknown
  extractHtml(text: string): string
}

/** 执行器持有的 MCP 取数能力（包装 mcp） */
export interface McpAdapter {
  listTools(source: McpDataSource): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>
  callTool(source: McpDataSource, tool: string, args: Record<string, unknown>): Promise<string>
}

/** 执行器持有的存储能力（包装 store） */
export interface StorageAdapter {
  /** 存 HTML 产物 */
  writePreview(dashId: string, versionId: string, html: string): void
  readPreview(dashId: string, versionId: string): string | null
  /** 存版本元数据（取数明细等） */
  writeVersionMeta(dashId: string, versionId: string, meta: unknown): void
  readVersionMeta<T = unknown>(dashId: string, versionId: string): T | null
  /** 存真实数据 data.json（大屏 HTML 运行时 fetch 读取，不再写死数值） */
  writeDataFile(dashId: string, versionId: string, data: unknown): void
  readDataFile<T = unknown>(dashId: string, versionId: string): T | null
  /** 读 data.json 原始字符串（发布/下载内联用，避免二次序列化） */
  readDataFileText(dashId: string, versionId: string): string | null
  /** 存截图 */
  writeShot(dashId: string, name: string, dataUrl: string): string
  /** 发 SSE 事件 */
  emit(dashId: string, type: string, payload: unknown): void
  /** 存会话快照 */
  saveSession(dashId: string, session: unknown): void
  loadSession<T = unknown>(dashId: string): T | null
}

/** 模板能力（包装 templates） */
export interface TemplateAdapter {
  catalogText(): string
  keywordHint(text: string): string
  findTemplate(id: string): { html: string; image: string; name: string } | undefined
  templatesByType(type: 'layout' | 'component'): Array<{ id: string; name: string; html: string; image: string; tags: string[]; dataKind: string[]; slot: string[]; description: string }>
  templateImageDataUrl(templatesRoot: string, relPath: string): string | null
}

/** 取数规划里的一条调用 */
export interface DataFetchCall {
  sourceId: string
  tool: string
  args: Record<string, unknown>
  purpose: string
  /** 该数据画到哪个面板（新增：直击硬编码） */
  panel?: string
}

/** 模板匹配模块 */
export interface MatchModule {
  role: string
  slot: string
  dataKind: string
  templateId: string | null
  reason: string
}

/** 参考图精读清单 */
export interface ReplicaInventory {
  title: string
  layout: string
  panels: Array<{ name: string; position: string; content: string }>
  kpis: string[]
  colors: string
  hasMap: boolean
  mapAdcode: string
  mapCities: string[]
  notes: string
}

/** 地图路径 */
export interface MapPaths {
  [name: string]: { d: string; cx: number; cy: number }
}
