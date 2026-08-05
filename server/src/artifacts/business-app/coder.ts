/**
 * business-app 模型修复器。
 *
 * 模型只能替换有限的运行时展示文件，领域契约、应用蓝图和证据文件始终不可编辑。
 */
import * as gw from '../../gateway'
import { prompt } from '../../prompts'
import type { ModelSettings, ValidationGateResult } from '../../wire'
import type { ArtifactDraft } from '../types'
import { validateBusinessAppBuildInput } from './builder'
import { loadBusinessAppEnterpriseDesign } from './generation/enterprise-design'

const EDITABLE_FILE = /^(?:src\/App\.vue|src\/main\.ts|src\/(?:components|views)\/[A-Za-z0-9_./-]+\.vue|src\/composables\/[A-Za-z0-9_./-]+\.ts|src\/styles\/[A-Za-z0-9_.-]+\.css)$/
const MAX_UPDATES = 12
const MAX_UPDATE_BYTES = 512 * 1024

/** 模型返回的单个完整文件替换。 */
interface FileUpdate {
  path: string
  content: string
  reason?: string
}

/**
 * 请求模型提出有界的源码修复，并用与初次生成相同的静态安全策略重新准入。
 *
 * @returns 合法修复草稿；模型不可用、输出越界或内容不安全时返回 null。
 */
export async function repairBusinessAppWithModel(
  source: ArtifactDraft,
  requirement: string,
  failedGates: ValidationGateResult[],
  settings?: ModelSettings
): Promise<{ draft: ArtifactDraft; actions: string[] } | null> {
  if (!settings?.apiBase || !settings.model) return null
  const editableFiles = Object.fromEntries(
    Object.entries(source.files).filter(([file]) => EDITABLE_FILE.test(file))
  )
  const enterpriseDesign = loadBusinessAppEnterpriseDesign()
  const response = await gw.chatCompletion(settings, {
    role: 'coder',
    temperature: 0.05,
    maxTokens: 12_000,
    messages: [
      {
        role: 'system',
        content: prompt('business-app-repair.system', {
          repairGuidance: enterpriseDesign.repairGuidance
        })
      },
      {
        role: 'user',
        content: prompt('business-app-repair.user', {
          requirement,
          failedGates: failedGates
            .map(gate => `- ${gate.id}: ${gate.title}；期望通过；实际：${gate.detail ?? '未通过'}`)
            .join('\n'),
          editableFiles: JSON.stringify(editableFiles)
        })
      }
    ]
  })
  const parsed = gw.extractJson(response) as { updates?: unknown }
  if (!Array.isArray(parsed.updates) || parsed.updates.length === 0 || parsed.updates.length > MAX_UPDATES) {
    return null
  }
  const updates = parsed.updates.filter((item): item is FileUpdate => {
    if (!item || typeof item !== 'object') return false
    const update = item as Partial<FileUpdate>
    return typeof update.path === 'string' && typeof update.content === 'string'
  })
  if (updates.length !== parsed.updates.length) return null
  const files = { ...source.files }
  let bytes = 0
  for (const update of updates) {
    if (!EDITABLE_FILE.test(update.path) || !(update.path in editableFiles)) return null
    bytes += Buffer.byteLength(update.content, 'utf8')
    if (bytes > MAX_UPDATE_BYTES) return null
    files[update.path] = update.content
  }
  const draft = { entryFile: source.entryFile, files }
  validateBusinessAppBuildInput(draft)
  return {
    draft,
    actions: updates.map(update => update.reason?.trim() || `修复 ${update.path}`).slice(0, MAX_UPDATES)
  }
}
