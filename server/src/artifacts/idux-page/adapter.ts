import type {
  ArtifactManifest,
  TargetProfile,
  ValidationGateResult,
  ValidationReport
} from '../../wire'
import type { ArtifactAdapter, ArtifactDraft } from '../types'

function result(
  id: string,
  title: string,
  passed: boolean,
  detail: string | null = null
): ValidationGateResult {
  return { id, title, status: passed ? 'passed' : 'failed', detail: passed ? null : detail }
}

function exactIduxVersion(packageJsonText: string): string | null {
  try {
    const pkg = JSON.parse(packageJsonText) as { dependencies?: Record<string, unknown> }
    const raw = pkg.dependencies?.['@idux/components']
    return typeof raw === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw) ? raw : null
  } catch {
    return null
  }
}

function dependencyPolicy(packageJsonText: string): { passed: boolean; detail: string | null } {
  try {
    const pkg = JSON.parse(packageJsonText) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      scripts?: Record<string, unknown>
    }
    const allowed = new Set([
      '@idux/cdk',
      '@idux/components',
      'vue',
      '@vitejs/plugin-vue',
      'vite'
    ])
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ]
    const unexpected = names.filter(name => !allowed.has(name))
    const allVersionsExact = [
      ...Object.values(pkg.dependencies ?? {}),
      ...Object.values(pkg.devDependencies ?? {})
    ].every(version =>
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    )
    const expectedScripts = { dev: 'vite', build: 'vite build', preview: 'vite preview' }
    const scriptsPassed = JSON.stringify(pkg.scripts ?? {}) === JSON.stringify(expectedScripts)
    return {
      passed: unexpected.length === 0 && allVersionsExact && scriptsPassed,
      detail: unexpected.length > 0
        ? `包含未授权依赖：${unexpected.join('、')}`
        : !allVersionsExact
          ? '所有依赖都必须使用精确版本'
          : !scriptsPassed
            ? 'package.json scripts 不符合受控模板'
            : null
    }
  } catch {
    return { passed: false, detail: 'package.json 不是有效 JSON' }
  }
}

function styleEvidencePolicy(
  evidenceText: string,
  expectedVersion: string | null
): { passed: boolean; detail: string | null; theme: 'light' | 'dark' | null } {
  try {
    const value = JSON.parse(evidenceText) as {
      schemaVersion?: unknown
      skills?: unknown
      iduxVersion?: unknown
      sourceCommit?: unknown
      combinedSha256?: unknown
      theme?: unknown
      reference?: {
        mode?: unknown
        analyzer?: unknown
        imageCount?: unknown
        imageSha256?: unknown
        analysisSha256?: unknown
      }
      style?: {
        skill?: unknown
        profile?: unknown
        iduxVersion?: unknown
        sourceCommit?: unknown
        repository?: unknown
        website?: unknown
        viewports?: unknown
        assetsSha256?: unknown
      }
    }
    const skills = Array.isArray(value.skills) ? value.skills : []
    const style = value.style
    const reference = value.reference
    const validReference = reference === undefined || (
      reference.mode === 'vision-structured-spec' &&
      reference.analyzer === 'idux-page-reference-v1' &&
      reference.imageCount === 1 &&
      typeof reference.imageSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(reference.imageSha256) &&
      typeof reference.analysisSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(reference.analysisSha256)
    )
    const valid =
      !/\bdata:image\//i.test(evidenceText) &&
      value.schemaVersion === 1 &&
      skills.length === 2 &&
      skills.includes('idux-cli') &&
      skills.includes('idux-style') &&
      typeof expectedVersion === 'string' &&
      value.iduxVersion === expectedVersion &&
      typeof value.sourceCommit === 'string' &&
      /^[0-9a-f]{40}$/.test(value.sourceCommit) &&
      typeof value.combinedSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.combinedSha256) &&
      (value.theme === 'light' || value.theme === 'dark') &&
      style?.skill === 'idux-style' &&
      style.profile === 'business-page' &&
      style.iduxVersion === expectedVersion &&
      style.sourceCommit === value.sourceCommit &&
      style.repository === 'https://github.com/IDuxFE/idux' &&
      style.website === 'https://idux.site/' &&
      validReference &&
      Array.isArray(style.viewports) &&
      JSON.stringify(style.viewports) === JSON.stringify(['1920x1080', '1366x768']) &&
      typeof style.assetsSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(style.assetsSha256)
    return {
      passed: valid,
      detail: valid
        ? null
        : 'generation-evidence.json 必须同时证明 idux-cli 组件证据与 idux-style 设计基线，且版本、提交和双视口一致',
      theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : null
    }
  } catch {
    return {
      passed: false,
      detail: 'generation-evidence.json 不是有效 JSON',
      theme: null
    }
  }
}

export const iduxPageArtifactAdapter: ArtifactAdapter = {
  kind: 'idux-page',

  createTargetProfile(): TargetProfile {
    return {
      framework: 'vue3',
      uiLibrary: 'idux',
      uiLibraryVersion: '2.11.0',
      viewportProfiles: ['1920x1080', '1366x768']
    }
  },

  createManifest(draft?: ArtifactDraft): ArtifactManifest {
    return {
      schemaVersion: 1,
      kind: 'idux-page',
      entryFile: draft?.entryFile ?? 'index.html',
      files: draft ? Object.keys(draft.files).sort() : [],
      exportFormat: 'zip'
    }
  },

  validateDraft(draft: ArtifactDraft): ValidationReport {
    const required = [
      'index.html',
      'package.json',
      'src/main.ts',
      'src/App.vue',
      'src/page-shell.css',
      'generation-evidence.json'
    ]
    const missing = required.filter(file => !(file in draft.files))
    const combined = Object.values(draft.files).join('\n')
    const mainSource = draft.files['src/main.ts'] ?? ''
    const appSource = draft.files['src/App.vue'] ?? ''
    const pageCss = draft.files['src/page-shell.css'] ?? ''
    const iduxVersion = exactIduxVersion(draft.files['package.json'] ?? '')
    const dependencies = dependencyPolicy(draft.files['package.json'] ?? '')
    const evidence = styleEvidencePolicy(
      draft.files['generation-evidence.json'] ?? '',
      iduxVersion
    )
    const hasRemoteCode = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(combined)
    const iduxComponents = new Set(
      [...appSource.matchAll(/<Ix([A-Z][A-Za-z0-9]*)\b/g)].map(match => match[1])
    )
    const nativeInteractive = /<(?:button|input|select|textarea)\b/i.test(appSource)
    const gates = [
      result(
        'required-files',
        '项目文件完整',
        missing.length === 0,
        missing.length > 0 ? `缺少：${missing.join('、')}` : null
      ),
      result(
        'exact-idux-version',
        'IDux 使用精确版本',
        Boolean(iduxVersion),
        'package.json 必须锁定 @idux/components 精确版本'
      ),
      result(
        'dependency-allowlist',
        '依赖符合允许清单',
        dependencies.passed,
        dependencies.detail
      ),
      result(
        'no-remote-code',
        '不加载远程代码',
        !hasRemoteCode,
        '检测到远程脚本或样式地址'
      ),
      result(
        'idux-style-entry',
        'IDux 组件结构样式与完整主题已加载',
        /import\s+["']@idux\/components\/index\.full\.css["']/.test(mainSource) &&
          (
            evidence.theme === 'dark'
              ? /import\s+["']@idux\/components\/dark\.full\.css["']/.test(mainSource)
              : evidence.theme === 'light' &&
                /import\s+["']@idux\/components\/default\.full\.css["']/.test(mainSource)
          ),
        '必须同时加载 index.full.css（组件结构）与 default.full.css 或 dark.full.css（完整主题变量）'
      ),
      result(
        'idux-component-surface',
        '交互和主要容器使用 IDux 组件',
        iduxComponents.size >= 4 && !nativeInteractive,
        nativeInteractive
          ? '检测到原生交互控件，必须改用对应的 IxButton、IxInput、IxSelect 等组件'
          : `只检测到 ${iduxComponents.size} 类 IDux 组件，业务页面至少需要四类组件形成完整体验`
      ),
      result(
        'idux-design-tokens',
        '自定义布局遵循 IDux 设计令牌',
        /var\(\s*--ix-(?:color|font|margin|padding|box-shadow|component)/.test(pageCss),
        '自定义 CSS 必须使用 IDux 颜色、字体、间距或阴影令牌，避免形成另一套视觉语言'
      ),
      result(
        'idux-style-evidence',
        '组件 API 与设计规范证据可追溯',
        evidence.passed,
        evidence.detail
      )
    ]
    return {
      status: gates.every(gate => gate.status === 'passed') ? 'passed' : 'failed',
      gates
    }
  },

  exportFileName(projectName: string, revisionLabel: string): string {
    return `${projectName}-${revisionLabel}.zip`
  }
}
