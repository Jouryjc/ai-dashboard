/**
 * IDux 业务应用设计系统加载器。
 *
 * 设计证据只从本地 idux-style skill 读取，并对路径、大小、版本和目标视口做严格校验，
 * 防止模型自行编造组件版本或加载工作区外资源。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { skillRegistry } from '../../../skills/registry'

/** idux-style 清单的内部结构；仅接受当前业务应用 Schema。 */
interface IduxStyleManifest {
  schemaVersion: 2
  skill: 'idux-style'
  profile: 'business-app'
  iduxVersion: string
  source: {
    repository: string
    website: string
    commit: string
  }
  themes: ['light', 'dark']
  viewports: Array<{ name: 'large' | 'small'; width: number; height: number }>
}

/** 写入生成证据的可审计设计系统来源。 */
export interface BusinessAppDesignEvidence {
  skill: 'idux-style'
  profile: 'business-app'
  iduxVersion: string
  sourceCommit: string
  repository: string
  website: string
  viewports: string[]
  assetsSha256: string
}

/** 生成器消费的样式、规划规范与证据集合。 */
export interface BusinessAppDesignSystem {
  css: string
  plannerGuidance: string
  evidence: BusinessAppDesignEvidence
}

/** 安全读取 skill 内文件，拒绝目录穿越、缺失文件和超大资源。 */
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

/** 解析并校验设计清单版本、来源提交、主题和固定目标视口。 */
function parseManifest(source: string): IduxStyleManifest {
  const value = JSON.parse(source) as Partial<IduxStyleManifest>
  const viewports = value.viewports
  if (
    value.schemaVersion !== 2 ||
    value.skill !== 'idux-style' ||
    value.profile !== 'business-app' ||
    typeof value.iduxVersion !== 'string' ||
    typeof value.source?.repository !== 'string' ||
    typeof value.source.website !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.source.commit ?? '') ||
    JSON.stringify(value.themes) !== JSON.stringify(['light', 'dark']) ||
    !Array.isArray(viewports) ||
    !viewports.some(item => item.name === 'large' && item.width === 1920 && item.height === 1080) ||
    !viewports.some(item => item.name === 'small' && item.width === 1366 && item.height === 768)
  ) {
    throw new Error('idux-style 业务应用设计清单不完整')
  }
  return value as IduxStyleManifest
}

/** 加载 business-app 使用的 IDux 样式资产，并计算内容摘要用于追踪。 */
export function loadBusinessAppDesignSystem(): BusinessAppDesignSystem {
  const skill = skillRegistry.get('idux-style')
  const manifestSource = readSkillFile(skill.directory, 'assets/style-manifest.json')
  const css = readSkillFile(skill.directory, 'assets/app-shell.css')
  const plannerGuidance = readSkillFile(skill.directory, 'references/planner-guidance.md')
  const manifest = parseManifest(manifestSource)
  return {
    css,
    plannerGuidance,
    evidence: {
      skill: 'idux-style',
      profile: 'business-app',
      iduxVersion: manifest.iduxVersion,
      sourceCommit: manifest.source.commit,
      repository: manifest.source.repository,
      website: manifest.source.website,
      viewports: manifest.viewports.map(viewport => `${viewport.width}x${viewport.height}`),
      assetsSha256: crypto
        .createHash('sha256')
        .update([manifestSource, css, plannerGuidance].join('\n---\n'))
        .digest('hex')
    }
  }
}
