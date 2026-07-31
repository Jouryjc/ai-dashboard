import crypto from 'node:crypto'
import * as gw from '../../gateway'
import { prompt } from '../../prompts'
import type { ModelSettings } from '../../wire'

export type IduxReferenceNavigation = 'none' | 'top' | 'side'
export type IduxReferenceDensity = 'compact' | 'comfortable'
export type IduxReferenceSurface = 'flat' | 'card'

export interface IduxReferenceAnalysis {
  pagePattern: 'management-list' | 'unknown'
  title: string
  description: string
  entityName: string
  primaryAction: string
  navigation: IduxReferenceNavigation
  navigationItems: string[]
  summaryCards: Array<{
    label: string
    value: string
    helper: string
    tone: 'normal' | 'success' | 'warning'
  }>
  columns: Array<{ label: string; type: 'text' | 'number' | 'status' | 'datetime' }>
  density: IduxReferenceDensity
  surface: IduxReferenceSurface
  toolbar: 'inline' | 'stacked'
  theme: 'light' | 'dark'
  visibleTexts: string[]
  unreadable: string[]
  redactions: string[]
  confidence: 'high' | 'medium' | 'low'
}

export interface IduxReferenceEvidence {
  mode: 'vision-structured-spec'
  analyzer: 'idux-page-reference-v1'
  imageCount: 1
  imageSha256: string
  analysisSha256: string
}

const ENUM = {
  navigation: new Set<IduxReferenceNavigation>(['none', 'top', 'side']),
  density: new Set<IduxReferenceDensity>(['compact', 'comfortable']),
  surface: new Set<IduxReferenceSurface>(['flat', 'card']),
  toolbar: new Set<IduxReferenceAnalysis['toolbar']>(['inline', 'stacked']),
  theme: new Set<IduxReferenceAnalysis['theme']>(['light', 'dark']),
  confidence: new Set<IduxReferenceAnalysis['confidence']>(['high', 'medium', 'low']),
  columnType: new Set<IduxReferenceAnalysis['columns'][number]['type']>([
    'text',
    'number',
    'status',
    'datetime'
  ]),
  tone: new Set<IduxReferenceAnalysis['summaryCards'][number]['tone']>([
    'normal',
    'success',
    'warning'
  ])
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(value) ? value : [])
    .map(item => text(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
}

function parseAnalysis(value: unknown): IduxReferenceAnalysis {
  if (!value || typeof value !== 'object') throw new Error('IDux 参考图分析结果不是对象')
  const raw = value as Record<string, unknown>
  const rawCards = Array.isArray(raw.summaryCards) ? raw.summaryCards : []
  const rawColumns = Array.isArray(raw.columns) ? raw.columns : []
  const summaryCards = rawCards.slice(0, 4).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const card = item as Record<string, unknown>
    const label = text(card.label, 20)
    const valueText = text(card.value, 24)
    if (!label || !valueText) return []
    const tone = ENUM.tone.has(card.tone as never)
      ? card.tone as IduxReferenceAnalysis['summaryCards'][number]['tone']
      : 'normal'
    return [{
      label,
      value: valueText,
      helper: text(card.helper, 30),
      tone
    }]
  })
  const columns = rawColumns.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const column = item as Record<string, unknown>
    const label = text(column.label, 16)
    if (!label) return []
    const type = ENUM.columnType.has(column.type as never)
      ? column.type as IduxReferenceAnalysis['columns'][number]['type']
      : 'text'
    return [{ label, type }]
  })
  const navigation = ENUM.navigation.has(raw.navigation as never)
    ? raw.navigation as IduxReferenceNavigation
    : 'none'
  return {
    pagePattern: raw.pagePattern === 'management-list' ? 'management-list' : 'unknown',
    title: text(raw.title, 30),
    description: text(raw.description, 100),
    entityName: text(raw.entityName, 10),
    primaryAction: text(raw.primaryAction, 12),
    navigation,
    navigationItems: navigation === 'none' ? [] : stringList(raw.navigationItems, 6, 12),
    summaryCards,
    columns,
    density: ENUM.density.has(raw.density as never)
      ? raw.density as IduxReferenceDensity
      : 'comfortable',
    surface: ENUM.surface.has(raw.surface as never)
      ? raw.surface as IduxReferenceSurface
      : 'card',
    toolbar: ENUM.toolbar.has(raw.toolbar as never)
      ? raw.toolbar as IduxReferenceAnalysis['toolbar']
      : 'inline',
    theme: ENUM.theme.has(raw.theme as never)
      ? raw.theme as IduxReferenceAnalysis['theme']
      : 'light',
    visibleTexts: stringList(raw.visibleTexts, 24, 40),
    unreadable: stringList(raw.unreadable, 12, 60),
    redactions: stringList(raw.redactions, 12, 40),
    confidence: ENUM.confidence.has(raw.confidence as never)
      ? raw.confidence as IduxReferenceAnalysis['confidence']
      : 'low'
  }
}

function imageBytes(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i)
  if (!match) throw new Error('IDux 参考图必须是 PNG、JPEG 或 WebP 图片')
  const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error('IDux 参考图大小必须在 1 字节到 10MB 之间')
  }
  return bytes
}

export async function analyzeIduxPageReference(
  settings: ModelSettings,
  request: string,
  referenceImage: string,
  crops: string[] = []
): Promise<{ analysis: IduxReferenceAnalysis; evidence: IduxReferenceEvidence }> {
  const bytes = imageBytes(referenceImage)
  const content: Array<
    { type: 'text'; text: string } |
    { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text: prompt('idux-page-reference.user', {
        request: request.trim() || '（用户只提供了参考图）'
      })
    },
    { type: 'image_url', image_url: { url: referenceImage } }
  ]
  for (const crop of crops.slice(0, 5)) {
    imageBytes(crop)
    content.push({ type: 'image_url', image_url: { url: crop } })
  }
  const reply = await gw.chatCompletion(settings, {
    role: 'vision',
    temperature: 0,
    maxTokens: 2200,
    messages: [
      { role: 'system', content: prompt('idux-page-reference.system') },
      { role: 'user', content }
    ]
  })
  const analysis = parseAnalysis(gw.extractJson(reply))
  if (
    analysis.pagePattern !== 'management-list' ||
    !analysis.title ||
    !analysis.entityName ||
    analysis.columns.length < 3
  ) {
    throw new Error('参考图不是可可靠识别的 IDux 管理列表页，暂不能安全复刻')
  }
  const analysisJson = JSON.stringify(analysis)
  return {
    analysis,
    evidence: {
      mode: 'vision-structured-spec',
      analyzer: 'idux-page-reference-v1',
      imageCount: 1,
      imageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      analysisSha256: crypto.createHash('sha256').update(analysisJson).digest('hex')
    }
  }
}
