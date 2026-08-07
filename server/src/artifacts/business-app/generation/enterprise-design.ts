/**
 * 通用 B 端产品模式 Skill 加载器。
 *
 * 只读取受信任的本地 idux-enterprise-design 资源，将需求、规划、复核和修复规范分别注入
 * Loop 对应阶段，并以内容摘要保证生成证据可追溯。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { skillRegistry } from '../../../skills/registry'

interface EnterprisePatternManifest {
  schemaVersion: 1
  skill: 'idux-enterprise-design'
  profile: 'generic-b2b-management'
  iduxVersion: string
  iduxSource: {
    repository: string
    website: string
    commit: string
  }
  patternSource: {
    name: string
    website: string
    repository: string
    license: 'Apache-2.0'
    retrievedAt: string
    patterns: string[]
  }
  viewports: Array<{ name: 'large' | 'small' | 'embedded'; width: number; height: number }>
}

/** 写入生成证据的 B 端产品模式来源。 */
export interface BusinessAppEnterpriseDesignEvidence {
  skill: 'idux-enterprise-design'
  profile: 'generic-b2b-management'
  iduxVersion: string
  iduxSourceCommit: string
  sourceName: string
  sourceWebsite: string
  sourceRepository: string
  sourceLicense: 'Apache-2.0'
  retrievedAt: string
  patterns: string[]
  viewports: string[]
  assetsSha256: string
}

/** Loop 各阶段消费的精简规范和可审计来源。 */
export interface BusinessAppEnterpriseDesign {
  requirementsGuidance: string
  plannerGuidance: string
  reviewGuidance: string
  repairGuidance: string
  evidence: BusinessAppEnterpriseDesignEvidence
}

const HASHED_FILES = [
  'SKILL.md',
  'assets/pattern-manifest.json',
  'references/information-architecture.md',
  'references/page-patterns.md',
  'references/actions-states-feedback.md',
  'references/responsive-density.md',
  'references/idux-mapping.md',
  'references/loop-quality-gates.md',
  'references/requirements-guidance.md',
  'references/planner-guidance.md',
  'references/review-guidance.md',
  'references/repair-guidance.md',
  'references/sources-and-license.md'
] as const

/** 安全读取 Skill 内资源，拒绝目录穿越、缺失和超大文本。 */
function readSkillFile(directory: string, relativePath: string): string {
  const resolved = path.resolve(directory, relativePath)
  const relative = path.relative(directory, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`idux-enterprise-design 资源路径越界：${relativePath}`)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`idux-enterprise-design 缺少资源：${relativePath}`)
  }
  const source = fs.readFileSync(resolved, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) {
    throw new Error(`idux-enterprise-design 资源过大：${relativePath}`)
  }
  return source
}

/** 校验 Skill 来源、IDux 证据版本和三个目标视口。 */
function parseManifest(source: string): EnterprisePatternManifest {
  const value = JSON.parse(source) as Partial<EnterprisePatternManifest>
  const viewports = value.viewports
  if (
    value.schemaVersion !== 1 ||
    value.skill !== 'idux-enterprise-design' ||
    value.profile !== 'generic-b2b-management' ||
    typeof value.iduxVersion !== 'string' ||
    value.iduxSource?.repository !== 'https://github.com/IDuxFE/idux' ||
    value.iduxSource.website !== 'https://idux.site/' ||
    !/^[0-9a-f]{40}$/.test(value.iduxSource.commit ?? '') ||
    value.patternSource?.name !== 'AWS Cloudscape Design System' ||
    value.patternSource.website !== 'https://cloudscape.design/' ||
    value.patternSource.repository !== 'https://github.com/cloudscape-design/components' ||
    value.patternSource.license !== 'Apache-2.0' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.patternSource.retrievedAt ?? '') ||
    !Array.isArray(value.patternSource.patterns) ||
    value.patternSource.patterns.length < 8 ||
    !Array.isArray(viewports) ||
    !viewports.some(item => item.name === 'large' && item.width === 1920 && item.height === 1080) ||
    !viewports.some(item => item.name === 'small' && item.width === 1366 && item.height === 768) ||
    !viewports.some(item => item.name === 'embedded' && item.width === 862 && item.height === 623)
  ) {
    throw new Error('idux-enterprise-design 模式清单不完整')
  }
  return value as EnterprisePatternManifest
}

function joinSources(files: Map<string, string>, names: string[]): string {
  return names.map(name => files.get(name) ?? '').join('\n\n---\n\n')
}

/** 加载并按 Loop 阶段组织通用 B 端设计规范。 */
export function loadBusinessAppEnterpriseDesign(): BusinessAppEnterpriseDesign {
  const skill = skillRegistry.get('idux-enterprise-design')
  const files = new Map(HASHED_FILES.map(name => [name, readSkillFile(skill.directory, name)]))
  const manifest = parseManifest(files.get('assets/pattern-manifest.json') ?? '')
  const sharedPlanning = [
    'references/information-architecture.md',
    'references/page-patterns.md',
    'references/actions-states-feedback.md',
    'references/responsive-density.md',
    'references/idux-mapping.md'
  ]
  const quality = 'references/loop-quality-gates.md'
  return {
    requirementsGuidance: joinSources(files, [
      'references/requirements-guidance.md',
      'references/information-architecture.md'
    ]),
    plannerGuidance: joinSources(files, [
      'references/planner-guidance.md',
      ...sharedPlanning
    ]),
    reviewGuidance: joinSources(files, [
      'references/review-guidance.md',
      quality,
      'references/actions-states-feedback.md',
      'references/responsive-density.md'
    ]),
    repairGuidance: joinSources(files, [
      'references/repair-guidance.md',
      quality,
      'references/idux-mapping.md'
    ]),
    evidence: {
      skill: 'idux-enterprise-design',
      profile: 'generic-b2b-management',
      iduxVersion: manifest.iduxVersion,
      iduxSourceCommit: manifest.iduxSource.commit,
      sourceName: manifest.patternSource.name,
      sourceWebsite: manifest.patternSource.website,
      sourceRepository: manifest.patternSource.repository,
      sourceLicense: manifest.patternSource.license,
      retrievedAt: manifest.patternSource.retrievedAt,
      patterns: [...manifest.patternSource.patterns],
      viewports: manifest.viewports.map(viewport => `${viewport.width}x${viewport.height}`),
      assetsSha256: crypto
        .createHash('sha256')
        .update(HASHED_FILES.map(name => `${name}\n${files.get(name) ?? ''}`).join('\n---\n'))
        .digest('hex')
    }
  }
}
