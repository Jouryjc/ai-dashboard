import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { skillRegistry } from '../../skills/registry'
import type { IduxPageSpec } from './spec'

interface IduxStyleManifest {
  schemaVersion: 1
  skill: 'idux-style'
  profile: 'business-page'
  iduxVersion: string
  source: {
    repository: string
    website: string
    commit: string
  }
  themes: ['light', 'dark']
  viewports: Array<{ name: 'large' | 'small'; width: number; height: number }>
}

export interface IduxStyleEvidence {
  skill: 'idux-style'
  profile: 'business-page'
  iduxVersion: string
  sourceCommit: string
  repository: string
  website: string
  viewports: string[]
  assetsSha256: string
}

export interface IduxStyleBundle {
  appTemplate: string
  pageCss: string
  qualityOverrides: string
  plannerGuidance: string
  evidence: IduxStyleEvidence
}

function readSkillFile(directory: string, relativePath: string): string {
  const resolved = path.resolve(directory, relativePath)
  const relative = path.relative(directory, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`idux-style 资源路径越界：${relativePath}`)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`idux-style 缺少资源：${relativePath}`)
  }
  const source = fs.readFileSync(resolved, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) {
    throw new Error(`idux-style 资源过大：${relativePath}`)
  }
  return source
}

function parseManifest(source: string): IduxStyleManifest {
  const value = JSON.parse(source) as Partial<IduxStyleManifest>
  const viewports = value.viewports
  if (
    value.schemaVersion !== 1 ||
    value.skill !== 'idux-style' ||
    value.profile !== 'business-page' ||
    typeof value.iduxVersion !== 'string' ||
    typeof value.source?.repository !== 'string' ||
    typeof value.source.website !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.source.commit ?? '') ||
    !Array.isArray(value.themes) ||
    JSON.stringify(value.themes) !== JSON.stringify(['light', 'dark']) ||
    !Array.isArray(viewports) ||
    viewports.length !== 2 ||
    !viewports.some(item => item.name === 'large' && item.width === 1920 && item.height === 1080) ||
    !viewports.some(item => item.name === 'small' && item.width === 1366 && item.height === 768)
  ) {
    throw new Error('idux-style 样式清单不完整或视口定义不正确')
  }
  return value as IduxStyleManifest
}

export function loadIduxStyleBundle(): IduxStyleBundle {
  const skill = skillRegistry.get('idux-style')
  const manifestSource = readSkillFile(skill.directory, 'assets/style-manifest.json')
  const appTemplate = readSkillFile(skill.directory, 'assets/list-page.vue.tpl')
  const pageCss = readSkillFile(skill.directory, 'assets/page-shell.css')
  const qualityOverrides = readSkillFile(skill.directory, 'assets/quality-overrides.css')
  const plannerGuidance = readSkillFile(skill.directory, 'references/planner-guidance.md')
  const manifest = parseManifest(manifestSource)
  const assetsSha256 = crypto
    .createHash('sha256')
    .update([manifestSource, appTemplate, pageCss, qualityOverrides].join('\n---\n'))
    .digest('hex')

  return {
    appTemplate,
    pageCss,
    qualityOverrides,
    plannerGuidance,
    evidence: {
      skill: 'idux-style',
      profile: manifest.profile,
      iduxVersion: manifest.iduxVersion,
      sourceCommit: manifest.source.commit,
      repository: manifest.source.repository,
      website: manifest.source.website,
      viewports: manifest.viewports.map(viewport => `${viewport.width}x${viewport.height}`),
      assetsSha256
    }
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function columnWidth(type: IduxPageSpec['columns'][number]['type'], index: number): number {
  if (type === 'status') return 110
  if (type === 'datetime') return 180
  if (type === 'number') return 140
  return index === 0 ? 200 : 160
}

function replaceOnce(source: string, marker: string, value: string): string {
  const first = source.indexOf(marker)
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`idux-style 模板标记必须且只能出现一次：${marker}`)
  }
  return `${source.slice(0, first)}${value}${source.slice(first + marker.length)}`
}

export function renderIduxListPage(
  bundle: IduxStyleBundle,
  spec: IduxPageSpec
): { appVue: string; pageCss: string } {
  const detail = spec.detail ?? { enabled: false, title: `${spec.entityName}详情`, fields: [] }
  const columns = spec.columns.map((column, index) => ({
    title: column.label,
    dataKey: column.key,
    width: columnWidth(column.type, index),
    ...(column.type === 'status' ? { customCell: 'status' } : {})
  }))
  columns.push({ title: '操作', dataKey: 'action', width: 100, customCell: 'action' })
  const rows = spec.rows.map((row, index) => ({ key: `demo-${index + 1}`, ...row }))
  const scrollWidth = Math.max(
    1120,
    columns.reduce((total, column) => total + column.width, 0)
  )
  const publicSpec = {
    title: spec.title,
    description: spec.description,
    entityName: spec.entityName,
    primaryAction: spec.primaryAction,
    presentation: spec.presentation,
    summaryCards: spec.summaryCards,
    detail,
    detailFields: spec.columns
      .filter(column => detail.fields.includes(column.key))
      .map(column => ({ key: column.key, label: column.label }))
  }

  let appVue = bundle.appTemplate
  appVue = replaceOnce(appVue, '__IDUX_SPEC_JSON__', safeJson(publicSpec))
  appVue = replaceOnce(appVue, '__IDUX_COLUMNS_JSON__', safeJson(columns))
  appVue = replaceOnce(appVue, '__IDUX_ROWS_JSON__', safeJson(rows))
  appVue = replaceOnce(appVue, '__IDUX_SCROLL_WIDTH__', String(scrollWidth))
  if (/__IDUX_[A-Z_]+__/.test(appVue)) throw new Error('idux-style 模板存在未解析标记')
  return { appVue, pageCss: bundle.pageCss }
}
