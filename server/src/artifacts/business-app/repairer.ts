/**
 * business-app 确定性修复器。
 *
 * 只恢复经过版本控制的 IDux 主题入口和双视口应用壳，不对未知失败进行猜测性改写。
 */
import type { ValidationGateResult } from '../../wire'
import type { ArtifactDraft } from '../types'
import { loadBusinessAppDesignSystem } from './generation/design-system'

/** 修复后的草稿和可展示的修复动作。 */
export interface BusinessAppDraftRepair {
  draft: ArtifactDraft
  actions: string[]
}

/**
 * 执行有界且可审计的确定性修复。
 *
 * 未知问题保持未解决状态，由 Loop 继续选择其他策略或最终请求人工协助，避免虚假宣称已修复。
 */
export function repairBusinessAppDraft(
  source: ArtifactDraft,
  failedGates: ValidationGateResult[]
): BusinessAppDraftRepair {
  const files = { ...source.files }
  const actions: string[] = []
  const failedIds = new Set(failedGates.map(gate => gate.id))
  const hasFailedPrefix = (prefix: string): boolean =>
    [...failedIds].some(id => id === prefix || id.startsWith(`${prefix}-`))
  const styleFailure = [
    'idux-style-entry',
    'runtime-idux-styles',
    'runtime-theme-consistency',
    'visual-color-contrast',
    'visual-baseline',
    'visual-idux-style'
  ].some(id => hasFailedPrefix(id))

  if (styleFailure) {
    const main = files['src/main.ts'] ?? ''
    const selectedTheme = /"theme"\s*:\s*"dark"/.test(files['src/App.vue'] ?? '')
      ? 'dark'
      : 'default'
    const nextMain = main
      .replace(
        /import\s+["']@idux\/components\/(?:(?:default|dark)(?:\.full)?|index\.full)\.css["'];?\s*/g,
        ''
      )
      .replace(
        /import\s+\{\s*createApp\s*\}\s+from\s+["']vue["'];?/,
        match => `${match}\nimport '@idux/components/index.full.css'\nimport '@idux/components/${selectedTheme}.full.css'`
      )
    if (nextMain !== main) {
      files['src/main.ts'] = nextMain
      actions.push('恢复 IDux 全量组件结构与默认主题变量')
    }
  }

  const layoutFailure = [
    'large-screen-layout',
    'small-screen-layout',
    'small-screen-usability',
    'visual-hierarchy',
    'visual-readability',
    'visual-density',
    'visual-responsive'
  ].some(id => hasFailedPrefix(id))
  if (layoutFailure) {
    const expectedCss = loadBusinessAppDesignSystem().css
    if (files['src/styles/app-shell.css'] !== expectedCss) {
      files['src/styles/app-shell.css'] = expectedCss
      actions.push('恢复经过双视口约束的 IDux 业务应用壳样式')
    }
  }

  return {
    draft: { entryFile: source.entryFile, files },
    actions
  }
}
