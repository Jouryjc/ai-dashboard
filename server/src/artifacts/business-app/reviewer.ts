/**
 * business-app 视觉复核器。
 *
 * 将双视口首屏、场景结果页和可选参考图提交给视觉模型，只接受结构化且级别一致的复核结论。
 */
import * as gw from '../../gateway'
import { prompt } from '../../prompts'
import type { ModelSettings, ValidationGateResult } from '../../wire'

/** 视觉问题的受控分类。 */
export type BusinessAppVisualCategory =
  | 'idux-style'
  | 'hierarchy'
  | 'readability'
  | 'density'
  | 'responsive'
  | 'content'
  | 'interaction'

/** 单条视觉问题及其阻断级别。 */
export interface BusinessAppVisualFinding {
  category: BusinessAppVisualCategory
  severity: 'major' | 'minor'
  detail: string
}

/** 模型视觉复核结果及转换后的质量门禁。 */
export interface BusinessAppVisualReview {
  gates: ValidationGateResult[]
  findings: BusinessAppVisualFinding[]
  reviewedByModel: boolean
}

const CATEGORIES = new Set<BusinessAppVisualCategory>([
  'idux-style',
  'hierarchy',
  'readability',
  'density',
  'responsive',
  'content',
  'interaction'
])

/** 解析并校验视觉模型结论，拒绝未知分类和自相矛盾的 verdict。 */
function parseReview(value: unknown): BusinessAppVisualFinding[] {
  if (!value || typeof value !== 'object') throw new Error('视觉验收结果不是对象')
  const raw = value as { verdict?: unknown; issues?: unknown }
  if ((raw.verdict !== 'pass' && raw.verdict !== 'repair') || !Array.isArray(raw.issues)) {
    throw new Error('视觉验收结果字段不完整')
  }
  const findings = raw.issues.slice(0, 4).map(item => {
    if (!item || typeof item !== 'object') throw new Error('视觉问题不是对象')
    const issue = item as Partial<BusinessAppVisualFinding>
    if (
      !CATEGORIES.has(issue.category as BusinessAppVisualCategory) ||
      (issue.severity !== 'major' && issue.severity !== 'minor') ||
      typeof issue.detail !== 'string' ||
      issue.detail.trim().length < 10 ||
      issue.detail.trim().length > 120
    ) {
      throw new Error('视觉问题字段不合法')
    }
    return {
      category: issue.category as BusinessAppVisualCategory,
      severity: issue.severity,
      detail: issue.detail.trim()
    }
  })
  if (raw.verdict === 'pass' && findings.some(item => item.severity === 'major')) {
    throw new Error('视觉验收结论与问题等级矛盾')
  }
  return findings
}

/** 在视觉模型不可用或输出不可信时生成明确的降级门禁。 */
function fallbackReview(detail: string, required: boolean): BusinessAppVisualReview {
  return {
    reviewedByModel: false,
    findings: [],
    gates: [{
      id: 'model-visual-review',
      title: '视觉模型复核',
      status: required ? 'failed' : 'skipped',
      detail
    }]
  }
}

/** 对业务应用双视口、关键场景和可选参考图执行视觉复核。 */
export async function reviewBusinessAppVisual(
  settings: ModelSettings,
  request: string,
  screenshot: Buffer | null,
  smallScreenshot: Buffer | null,
  referenceImage: string | null = null,
  scenarioScreenshots: Buffer[] = []
): Promise<BusinessAppVisualReview> {
  if (
    !screenshot ||
    !smallScreenshot ||
    !settings.apiBase?.trim() ||
    !settings.apiKey?.trim() ||
    !settings.model?.trim()
  ) {
    return fallbackReview(
      referenceImage
        ? '参考图生成必须完成视觉模型对比，但模型或双视口截图不可用'
        : '视觉模型或双视口截图不可用；本轮仅记录为跳过，不计作通过',
      Boolean(referenceImage)
    )
  }
  try {
    const content: Array<
      { type: 'text'; text: string } |
      { type: 'image_url'; image_url: { url: string } }
    > = [
      {
        type: 'text',
        text: prompt('business-app-review.user', {
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
    scenarioScreenshots.slice(0, 4).forEach((shot, index) => {
      content.push(
        { type: 'text', text: `截图 ${index + 1}D：执行需求验收场景后的业务视图或结果状态。` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.toString('base64')}` } }
      )
    })
    const reply = await gw.chatCompletion(settings, {
      role: 'vision',
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: prompt('business-app-review.system') },
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
    return fallbackReview(
      referenceImage
        ? '参考图生成必须完成视觉模型对比，但模型没有返回可信结构'
        : '视觉模型没有返回可信结构；本轮仅记录为跳过，不计作通过',
      Boolean(referenceImage)
    )
  }
}
