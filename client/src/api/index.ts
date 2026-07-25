/**
 * API 入口：stores 只从这里拿 api 实例。
 * import.meta.env.VITE_API_BASE 存在时接真实服务端（HTTP+SSE 适配层），
 * 否则用本地 mock 剧本；stores 与 UI 零改动。
 */
import type { ClientApi } from './client'
import { createMockClient } from './mock/engine'
import { createHttpClient } from './http/client'

const API_BASE = import.meta.env.VITE_API_BASE as string | undefined

export const api: ClientApi = API_BASE ? createHttpClient(API_BASE) : createMockClient()

export type { ClientApi, ClientEventMap, WorkbenchSnapshot } from './client'
