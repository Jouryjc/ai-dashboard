import type { ArtifactKind } from '../wire'

export interface GenerationIntent {
  artifactKind: ArtifactKind | null
  confidence: number
  requiresClarification: boolean
  reason: string
  candidates: Array<{
    artifactKind: ArtifactKind
    title: string
    description: string
  }>
}

const DASHBOARD_SIGNALS: Array<[RegExp, number]> = [
  [/大屏/g, 4],
  [/驾驶舱/g, 4],
  [/数据看板|监控看板/g, 3],
  [/监控中心|指挥中心|全屏展示/g, 3],
  [/可视化|KPI|指标卡/g, 1]
]

const BUSINESS_APP_SIGNALS: Array<[RegExp, number]> = [
  [/\bIDux\b/gi, 5],
  [/业务应用|普通页面|业务页面|管理页面|管理页/g, 4],
  [/表格|数据表|列表/g, 3],
  [/表单|详情页|增删改查|CRUD/gi, 3],
  [/分页|筛选|搜索框/g, 2]
]

function score(text: string, signals: Array<[RegExp, number]>): number {
  return signals.reduce((total, [pattern, weight]) => {
    pattern.lastIndex = 0
    return total + ([...text.matchAll(pattern)].length * weight)
  }, 0)
}

const CANDIDATES: GenerationIntent['candidates'] = [
  {
    artifactKind: 'business-app',
    title: '业务应用',
    description: '可交互的列表、详情、表单和业务操作，支持导出 Vue 源码。'
  },
  {
    artifactKind: 'dashboard',
    title: '数据大屏',
    description: '固定画布、指标卡和数据可视化，适合全屏展示。'
  }
]

export function resolveGenerationIntent(
  text: string,
  explicitKind?: ArtifactKind
): GenerationIntent {
  if (explicitKind) {
    return {
      artifactKind: explicitKind,
      confidence: 1,
      requiresClarification: false,
      reason: '用户已明确选择产物类型。',
      candidates: CANDIDATES
    }
  }
  const dashboard = score(text, DASHBOARD_SIGNALS)
  const businessApp = score(text, BUSINESS_APP_SIGNALS)
  const strongest = Math.max(dashboard, businessApp)
  const gap = Math.abs(dashboard - businessApp)
  if (strongest >= 3 && gap >= 2) {
    const artifactKind: ArtifactKind = businessApp > dashboard ? 'business-app' : 'dashboard'
    return {
      artifactKind,
      confidence: Math.min(0.95, 0.65 + gap * 0.06),
      requiresClarification: false,
      reason: artifactKind === 'business-app'
        ? '需求以表格、列表或业务操作为主。'
        : '需求明确要求大屏或全屏可视化。',
      candidates: CANDIDATES
    }
  }
  return {
    artifactKind: null,
    confidence: strongest === 0 ? 0 : 0.5,
    requiresClarification: true,
    reason: strongest === 0
      ? '需求里没有足够信息判断展示形态。'
      : '需求同时包含数据大屏和业务应用特征。',
    candidates: CANDIDATES
  }
}
