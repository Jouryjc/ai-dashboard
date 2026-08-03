import type { ValidationGateResult } from '../../wire'
import type { ArtifactDraft } from '../types'
import { loadIduxStyleBundle } from './style-kit'

export interface BusinessAppDraftRepair {
  draft: ArtifactDraft
  actions: string[]
}

/**
 * Apply only bounded, auditable repairs. Unknown failures deliberately remain
 * unresolved so the loop blocks instead of claiming an arbitrary fix worked.
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
  if (layoutFailure && !('src/quality-overrides.css' in files)) {
    files['src/quality-overrides.css'] = loadIduxStyleBundle().qualityOverrides
    const main = files['src/main.ts'] ?? ''
    files['src/main.ts'] = main.includes("import './quality-overrides.css'")
      ? main
      : main.replace(
          /import\s+App\s+from\s+["']\.\/App\.vue["'];?/,
          match => `${match}\nimport './quality-overrides.css'`
        )
    actions.push('应用 1920×1080 与 1366×768 的有界布局修复')
  }

  return {
    draft: { entryFile: source.entryFile, files },
    actions
  }
}
