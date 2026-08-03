/**
 * business-app 参考图分析器。
 *
 * 将单张业务应用截图转换成脱敏的呈现证据；图片只影响应用壳、视图类型和视觉层级，不能替代文字需求的业务语义。
 */
import crypto from 'node:crypto'
import * as gw from '../../gateway'
import { prompt } from '../../prompts'
import type { ModelSettings } from '../../wire'

/** 参考图中可识别的导航结构。 */
export type BusinessAppReferenceNavigation = 'none' | 'top' | 'side'
/** 参考图中可识别的业务视图类型。 */
export type BusinessAppReferenceViewKind = 'overview' | 'list' | 'form' | 'detail' | 'workflow' | 'custom' | 'unknown'

/** 经过长度、枚举和隐私约束规范化后的参考图结构。 */
export interface BusinessAppReferenceAnalysis {
  viewKind: BusinessAppReferenceViewKind
  applicationName: string
  moduleName: string
  viewTitle: string
  description: string
  navigation: BusinessAppReferenceNavigation
  navigationItems: string[]
  primaryActions: string[]
  componentRoles: string[]
  sections: Array<{ title: string; role: string; visibleTexts: string[] }>
  fields: Array<{ label: string; role: 'identity' | 'status' | 'attribute' | 'time' | 'action' | 'input' }>
  density: 'compact' | 'comfortable'
  surface: 'flat' | 'card'
  theme: 'light' | 'dark'
  unreadable: string[]
  redactions: string[]
  confidence: 'high' | 'medium' | 'low'
}

/** 参考图及其结构化分析的摘要证据，不保存原始图片。 */
export interface BusinessAppReferenceEvidence {
  mode: 'vision-structured-spec'
  analyzer: 'business-app-reference-v2'
  imageCount: 1
  imageSha256: string
  analysisSha256: string
}

/** 安全读取并截断模型文本字段。 */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 安全读取有数量和长度上限的字符串数组。 */
function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(value) ? value : []).map(item => text(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

/** 解析并严格规范化视觉模型返回的参考图结构。 */
function parseAnalysis(value: unknown): BusinessAppReferenceAnalysis {
  if (!value || typeof value !== 'object') throw new Error('业务应用参考图分析结果不是对象')
  const raw = value as Record<string, unknown>
  const viewKinds = new Set<BusinessAppReferenceViewKind>(['overview', 'list', 'form', 'detail', 'workflow', 'custom', 'unknown'])
  const navigationKinds = new Set<BusinessAppReferenceNavigation>(['none', 'top', 'side'])
  const fieldRoles = new Set<BusinessAppReferenceAnalysis['fields'][number]['role']>(['identity', 'status', 'attribute', 'time', 'action', 'input'])
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, 10).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const section = item as Record<string, unknown>
    const title = text(section.title, 40)
    const role = text(section.role, 40)
    if (!title && !role) return []
    return [{ title, role, visibleTexts: stringList(section.visibleTexts, 20, 60) }]
  })
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, 16).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const field = item as Record<string, unknown>
    const label = text(field.label, 30)
    if (!label) return []
    return [{
      label,
      role: fieldRoles.has(field.role as never)
        ? field.role as BusinessAppReferenceAnalysis['fields'][number]['role']
        : 'attribute' as const
    }]
  })
  const viewKind = viewKinds.has(raw.viewKind as never) ? raw.viewKind as BusinessAppReferenceViewKind : 'unknown'
  const navigation = navigationKinds.has(raw.navigation as never) ? raw.navigation as BusinessAppReferenceNavigation : 'none'
  const analysis: BusinessAppReferenceAnalysis = {
    viewKind,
    applicationName: text(raw.applicationName, 40),
    moduleName: text(raw.moduleName, 30),
    viewTitle: text(raw.viewTitle, 40),
    description: text(raw.description, 120),
    navigation,
    navigationItems: navigation === 'none' ? [] : stringList(raw.navigationItems, 12, 24),
    primaryActions: stringList(raw.primaryActions, 6, 24),
    componentRoles: stringList(raw.componentRoles, 16, 40),
    sections,
    fields,
    density: raw.density === 'compact' ? 'compact' : 'comfortable',
    surface: raw.surface === 'flat' ? 'flat' : 'card',
    theme: raw.theme === 'dark' ? 'dark' : 'light',
    unreadable: stringList(raw.unreadable, 20, 80),
    redactions: stringList(raw.redactions, 20, 40),
    confidence: raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low'
  }
  if (analysis.viewKind === 'unknown' || (!analysis.viewTitle && analysis.sections.length === 0)) {
    throw new Error('参考图缺少足够的业务应用结构，无法可靠转换为应用蓝图')
  }
  return analysis
}

/** 校验图片 Data URL 的格式和大小，并返回原始字节用于计算摘要。 */
function imageBytes(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i)
  if (!match) throw new Error('业务应用参考图必须是 PNG、JPEG 或 WebP 图片')
  const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error('业务应用参考图大小必须在 1 字节到 10MB 之间')
  }
  return bytes
}

/** 分析一张业务应用参考图并生成不含原图的可追溯证据。 */
export async function analyzeBusinessAppReference(
  settings: ModelSettings,
  request: string,
  referenceImage: string,
  crops: string[] = []
): Promise<{ analysis: BusinessAppReferenceAnalysis; evidence: BusinessAppReferenceEvidence }> {
  const bytes = imageBytes(referenceImage)
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: prompt('business-app-reference.user', { request: request.trim() || '用户只提供了业务应用参考图' }) },
    { type: 'image_url', image_url: { url: referenceImage } }
  ]
  for (const crop of crops.slice(0, 5)) {
    imageBytes(crop)
    content.push({ type: 'image_url', image_url: { url: crop } })
  }
  const reply = await gw.chatCompletion(settings, {
    role: 'vision', temperature: 0, maxTokens: 2600,
    messages: [
      { role: 'system', content: prompt('business-app-reference.system') },
      { role: 'user', content }
    ]
  })
  const analysis = parseAnalysis(gw.extractJson(reply))
  return {
    analysis,
    evidence: {
      mode: 'vision-structured-spec',
      analyzer: 'business-app-reference-v2',
      imageCount: 1,
      imageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      analysisSha256: crypto.createHash('sha256').update(JSON.stringify(analysis)).digest('hex')
    }
  }
}
