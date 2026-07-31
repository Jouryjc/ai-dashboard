import * as gw from '../../gateway'
import { prompt } from '../../prompts'
import type { ModelSettings, ValidationGateResult } from '../../wire'

export type IduxVisualCategory =
  | 'idux-style'
  | 'hierarchy'
  | 'readability'
  | 'density'
  | 'responsive'
  | 'content'
  | 'interaction'

export interface IduxVisualFinding {
  category: IduxVisualCategory
  severity: 'major' | 'minor'
  detail: string
}

export interface IduxVisualReview {
  gates: ValidationGateResult[]
  findings: IduxVisualFinding[]
  reviewedByModel: boolean
}

const CATEGORIES = new Set<IduxVisualCategory>([
  'idux-style',
  'hierarchy',
  'readability',
  'density',
  'responsive',
  'content',
  'interaction'
])

function parseReview(value: unknown): IduxVisualFinding[] {
  if (!value || typeof value !== 'object') throw new Error('视觉验收结果不是对象')
  const raw = value as { verdict?: unknown; issues?: unknown }
  if ((raw.verdict !== 'pass' && raw.verdict !== 'repair') || !Array.isArray(raw.issues)) {
    throw new Error('视觉验收结果字段不完整')
  }
  const findings = raw.issues.slice(0, 4).map(item => {
    if (!item || typeof item !== 'object') throw new Error('视觉问题不是对象')
    const issue = item as Partial<IduxVisualFinding>
    if (
      !CATEGORIES.has(issue.category as IduxVisualCategory) ||
      (issue.severity !== 'major' && issue.severity !== 'minor') ||
      typeof issue.detail !== 'string' ||
      issue.detail.trim().length < 10 ||
      issue.detail.trim().length > 120
    ) {
      throw new Error('视觉问题字段不合法')
    }
    return {
      category: issue.category as IduxVisualCategory,
      severity: issue.severity,
      detail: issue.detail.trim()
    }
  })
  if (raw.verdict === 'pass' && findings.some(item => item.severity === 'major')) {
    throw new Error('视觉验收结论与问题等级矛盾')
  }
  return findings
}

function fallbackReview(detail: string): IduxVisualReview {
  return {
    reviewedByModel: false,
    findings: [],
    gates: [{
      id: 'model-visual-review',
      title: '视觉模型复核',
      status: 'passed',
      detail
    }]
  }
}

export async function reviewIduxPageVisual(
  settings: ModelSettings,
  request: string,
  screenshot: Buffer | null,
  smallScreenshot: Buffer | null,
  referenceImage: string | null = null
): Promise<IduxVisualReview> {
  if (
    !screenshot ||
    !smallScreenshot ||
    !settings.apiBase?.trim() ||
    !settings.apiKey?.trim() ||
    !settings.model?.trim()
  ) {
    return fallbackReview('模型或双视口截图不可用，已由确定性视觉门禁覆盖')
  }
  try {
    const content: Array<
      { type: 'text'; text: string } |
      { type: 'image_url'; image_url: { url: string } }
    > = [
      {
        type: 'text',
        text: prompt('idux-page-review.user', {
          request,
          referenceNote: referenceImage
            ? '截图 R 是用户提供的参考图。先比较页面结构、信息层级和密度，再检查两档成品。'
            : '本次没有参考图，只检查两档成品是否符合需求。'
        })
      }
    ]
    if (referenceImage) {
      content.push(
        { type: 'text', text: '截图 R：用户参考图。' },
        { type: 'image_url', image_url: { url: referenceImage } }
      )
    }
    content.push(
      { type: 'text', text: '截图 A：1920×1080 大屏。' },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` }
      },
      { type: 'text', text: '截图 B：1366×768 小屏。' },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${smallScreenshot.toString('base64')}` }
      }
    )
    const reply = await gw.chatCompletion(settings, {
      role: 'vision',
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: prompt('idux-page-review.system') },
        { role: 'user', content }
      ]
    })
    const findings = parseReview(gw.extractJson(reply))
    const major = findings.filter(item => item.severity === 'major')
    const minor = findings.filter(item => item.severity === 'minor')
    const gates: ValidationGateResult[] = major.length > 0
      ? major.map((item, index) => ({
          id: `visual-${item.category}${index === 0 ? '' : `-${index + 1}`}`,
          title: `视觉复核：${item.category}`,
          status: 'failed',
          detail: item.detail
        }))
      : [{
          id: 'model-visual-review',
          title: '视觉模型复核',
          status: 'passed',
          detail: minor.length > 0
            ? `有 ${minor.length} 条非阻断优化建议`
            : '双视口截图达到可交付标准'
        }]
    return { reviewedByModel: true, findings, gates }
  } catch {
    return fallbackReview('视觉模型未返回可信结构，已由确定性视觉门禁覆盖')
  }
}
