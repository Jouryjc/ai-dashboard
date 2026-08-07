/**
 * business-app 产物适配器。
 *
 * 负责声明目标运行环境，并在构建前验证文件完整性、领域契约、依赖白名单、IDux 证据与蓝图一致性。
 */
import type {
  ArtifactManifest,
  TargetProfile,
  ValidationGateResult,
  ValidationReport
} from '../../wire'
import type { ArtifactAdapter, ArtifactDraft } from '../types'
import type {
  BusinessApplicationBlueprint,
  BusinessAppChangePlan,
  BusinessAppRequirementContract
} from './domain/model'
import {
  validateBusinessApplicationBlueprint,
  validateBusinessAppChangePlan,
  validateRequirementContract
} from './domain/validation'
import { renderBlueprintSource } from './generation/renderer'

/** 创建统一的静态门禁结果。 */
function result(
  id: string,
  title: string,
  passed: boolean,
  detail: string | null = null
): ValidationGateResult {
  return { id, title, status: passed ? 'passed' : 'failed', detail: passed ? null : detail }
}

/** 从依赖清单中读取精确的 IDux 版本，拒绝版本范围。 */
function exactIduxVersion(packageJsonText: string): string | null {
  try {
    const pkg = JSON.parse(packageJsonText) as { dependencies?: Record<string, unknown> }
    const versions = ['@idux/cdk', '@idux/components', '@idux/pro']
      .map(name => pkg.dependencies?.[name])
    const [version] = versions
    return typeof version === 'string' &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) &&
      versions.every(item => item === version)
      ? version
      : null
  } catch {
    return null
  }
}

/** 校验依赖和 npm scripts 均处于受控白名单内。 */
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
      '@idux/pro',
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

/** 校验组件证据、设计基线和参考图证据的版本及摘要链。 */
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
      enterpriseDesign?: {
        skill?: unknown
        profile?: unknown
        iduxVersion?: unknown
        iduxSourceCommit?: unknown
        sourceName?: unknown
        sourceWebsite?: unknown
        sourceRepository?: unknown
        sourceLicense?: unknown
        retrievedAt?: unknown
        patterns?: unknown
        viewports?: unknown
        assetsSha256?: unknown
      }
    }
    const skills = Array.isArray(value.skills) ? value.skills : []
    const style = value.style
    const enterpriseDesign = value.enterpriseDesign
    const reference = value.reference
    const validReference = reference === undefined || (
      reference.mode === 'vision-structured-spec' &&
      reference.analyzer === 'business-app-reference-v2' &&
      reference.imageCount === 1 &&
      typeof reference.imageSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(reference.imageSha256) &&
      typeof reference.analysisSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(reference.analysisSha256)
    )
    const valid =
      !/\bdata:image\//i.test(evidenceText) &&
      value.schemaVersion === 3 &&
      skills.length === 3 &&
      skills.includes('idux-cli') &&
      skills.includes('idux-enterprise-design') &&
      skills.includes('idux-style') &&
      typeof expectedVersion === 'string' &&
      value.iduxVersion === expectedVersion &&
      typeof value.sourceCommit === 'string' &&
      /^[0-9a-f]{40}$/.test(value.sourceCommit) &&
      typeof value.combinedSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.combinedSha256) &&
      (value.theme === 'light' || value.theme === 'dark') &&
      style?.skill === 'idux-style' &&
      style.profile === 'business-app' &&
      style.iduxVersion === expectedVersion &&
      style.sourceCommit === value.sourceCommit &&
      style.repository === 'https://github.com/IDuxFE/idux' &&
      style.website === 'https://idux.site/' &&
      validReference &&
      Array.isArray(style.viewports) &&
      JSON.stringify(style.viewports) === JSON.stringify(['1920x1080', '1366x768']) &&
      typeof style.assetsSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(style.assetsSha256) &&
      enterpriseDesign?.skill === 'idux-enterprise-design' &&
      enterpriseDesign.profile === 'generic-b2b-management' &&
      enterpriseDesign.iduxVersion === expectedVersion &&
      enterpriseDesign.iduxSourceCommit === value.sourceCommit &&
      enterpriseDesign.sourceName === 'AWS Cloudscape Design System' &&
      enterpriseDesign.sourceWebsite === 'https://cloudscape.design/' &&
      enterpriseDesign.sourceRepository === 'https://github.com/cloudscape-design/components' &&
      enterpriseDesign.sourceLicense === 'Apache-2.0' &&
      typeof enterpriseDesign.retrievedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(enterpriseDesign.retrievedAt) &&
      Array.isArray(enterpriseDesign.patterns) &&
      enterpriseDesign.patterns.length >= 8 &&
      Array.isArray(enterpriseDesign.viewports) &&
      JSON.stringify(enterpriseDesign.viewports) === JSON.stringify(['1920x1080', '1366x768', '862x623']) &&
      typeof enterpriseDesign.assetsSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(enterpriseDesign.assetsSha256)
    return {
      passed: valid,
      detail: valid
        ? null
        : 'generation-evidence.json 必须同时证明 idux-cli、idux-enterprise-design 与 idux-style 的版本、来源、摘要和目标视口一致',
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

export const businessAppArtifactAdapter: ArtifactAdapter = {
  kind: 'business-app',

  /** 返回业务应用固定的框架、组件库和双视口目标。 */
  createTargetProfile(): TargetProfile {
    return {
      framework: 'vue3',
      uiLibrary: 'idux',
      uiLibraryVersion: '2.11.0',
      viewportProfiles: ['1920x1080', '1366x768']
    }
  },

  /** 根据草稿生成标准产物清单。 */
  createManifest(draft?: ArtifactDraft): ArtifactManifest {
    return {
      schemaVersion: 1,
      kind: 'business-app',
      entryFile: draft?.entryFile ?? 'index.html',
      files: draft ? Object.keys(draft.files).sort() : [],
      exportFormat: 'zip'
    }
  },

  /** 执行生成草稿的全部静态质量与安全门禁。 */
  validateDraft(draft: ArtifactDraft): ValidationReport {
    const required = [
      'index.html',
      'package.json',
      'src/main.ts',
      'src/App.vue',
      'src/app/blueprint.ts',
      'src/app/runtime-types.ts',
      'src/composables/use-business-app-runtime.ts',
      'src/components/shell/BusinessAppShell.vue',
      'src/components/shell/ViewHeading.vue',
      'src/components/feedback/ActionConfirmModal.vue',
      'src/components/views/OverviewView.vue',
      'src/components/views/ListView.vue',
      'src/components/views/FormView.vue',
      'src/components/views/DetailView.vue',
      'src/styles/app-shell.css',
      'src/contracts/requirement-contract.json',
      'src/contracts/application-blueprint.json',
      'src/contracts/change-plan.json',
      'src/contracts/acceptance-plan.json',
      'generation-evidence.json'
    ]
    const missing = required.filter(file => !(file in draft.files))
    const combined = Object.values(draft.files).join('\n')
    const mainSource = draft.files['src/main.ts'] ?? ''
    const appSource = draft.files['src/App.vue'] ?? ''
    const vueSource = Object.entries(draft.files)
      .filter(([file]) => file.endsWith('.vue'))
      .map(([, source]) => source)
      .join('\n')
    const shellSource = draft.files['src/components/shell/BusinessAppShell.vue'] ?? ''
    const confirmationSource = draft.files['src/components/feedback/ActionConfirmModal.vue'] ?? ''
    const pageCss = draft.files['src/styles/app-shell.css'] ?? ''
    const iduxVersion = exactIduxVersion(draft.files['package.json'] ?? '')
    const dependencies = dependencyPolicy(draft.files['package.json'] ?? '')
    const evidence = styleEvidencePolicy(
      draft.files['generation-evidence.json'] ?? '',
      iduxVersion
    )
    const hasRemoteCode = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(combined)
    const iduxComponents = new Set(
      [...vueSource.matchAll(/<Ix([A-Z][A-Za-z0-9]*)\b/g)].map(match => match[1])
    )
    const nativeInteractive = /<(?:button|input|select|textarea)\b/i.test(vueSource)
    const modularRuntime =
      /<BusinessAppShell\b/.test(appSource) &&
      !/<Ix(?:Table|Form|Desc|Modal)\b/.test(appSource) &&
      !/\b(?:reactive|recordStore|handleAction|submitForm)\b/.test(appSource) &&
      /useBusinessAppRuntime/.test(shellSource) &&
      Object.keys(draft.files).filter(file => file.endsWith('.vue')).length >= 8
    const proLayoutRuntime =
      /from\s+["']@idux\/pro\/layout["']/.test(shellSource) &&
      /<IxProLayout\b/.test(shellSource)
    const modalConfirmation =
      /from\s+["']@idux\/components\/modal["']/.test(confirmationSource) &&
      /<IxModal\b/.test(confirmationSource) &&
      /type=["']confirm["']/.test(confirmationSource) &&
      /data-testid=["']confirm-action["']/.test(confirmationSource) &&
      !/confirmation-card/.test(vueSource)
    let contractPassed = false
    let blueprintPassed = false
    let enterprisePatternPassed = false
    let planPassed = false
    let blueprintSourcePassed = false
    let acceptancePlanPassed = false
    let traceabilityDetail: string | null = null
    try {
      const contract = JSON.parse(draft.files['src/contracts/requirement-contract.json'] ?? '') as BusinessAppRequirementContract
      const blueprint = JSON.parse(draft.files['src/contracts/application-blueprint.json'] ?? '') as BusinessApplicationBlueprint
      const plan = JSON.parse(draft.files['src/contracts/change-plan.json'] ?? '') as BusinessAppChangePlan
      validateRequirementContract(contract)
      contractPassed = contract.status === 'ready'
      validateBusinessApplicationBlueprint(blueprint)
      blueprintPassed = blueprint.acceptanceScenarios.length > 0
      enterprisePatternPassed = blueprint.modules.every(module => module.views.every(view =>
        Boolean(view.experience.pattern) &&
        view.experience.responsivePriority.length > 0 &&
        view.experience.states.includes('ready') &&
        [...view.primaryActions, ...view.rowActions].every(action => Boolean(action.scope && action.expectedResult))
      ))
      blueprintSourcePassed = draft.files['src/app/blueprint.ts'] === renderBlueprintSource(blueprint)
      acceptancePlanPassed = JSON.stringify(JSON.parse(draft.files['src/contracts/acceptance-plan.json'] ?? '')) === JSON.stringify(blueprint.acceptanceScenarios)
      validateBusinessAppChangePlan(plan, blueprint)
      planPassed = plan.requirementIds.every(id => id in blueprint.requirementCoverage)
    } catch (error) {
      traceabilityDetail = error instanceof Error ? error.message : String(error)
    }
    const gates = [
      result(
        'required-files',
        '项目文件完整',
        missing.length === 0,
        missing.length > 0 ? `缺少：${missing.join('、')}` : null
      ),
      result(
        'requirement-contract',
        '需求已经收敛为可执行契约',
        contractPassed,
        traceabilityDetail ?? '需求契约未就绪'
      ),
      result(
        'application-blueprint',
        '应用蓝图包含模块、视图、实体和验收场景',
        blueprintPassed,
        traceabilityDetail ?? '应用蓝图缺少完整结构或验收场景'
      ),
      result(
        'blueprint-source-integrity',
        '运行时蓝图与已验收蓝图完全一致',
        blueprintSourcePassed,
        'src/app/blueprint.ts 与 application-blueprint.json 不一致'
      ),
      result(
        'acceptance-plan-integrity',
        '运行时验收计划与应用蓝图一致',
        acceptancePlanPassed,
        'acceptance-plan.json 与应用蓝图中的验收场景不一致'
      ),
      result(
        'change-plan-traceability',
        '变更计划可以追溯到需求与现有应用',
        planPassed,
        traceabilityDetail ?? '变更计划没有覆盖需求'
      ),
      result(
        'exact-idux-version',
        'IDux 核心包与 Pro 组件使用同一精确版本',
        Boolean(iduxVersion),
        'package.json 必须以同一精确版本锁定 @idux/cdk、@idux/components 与 @idux/pro'
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
        'IDux Components 与 Pro 的结构样式和完整主题已加载',
        /import\s+["']@idux\/components\/index\.full\.css["']/.test(mainSource) &&
          /import\s+["']@idux\/pro\/index\.css["']/.test(mainSource) &&
          (
            evidence.theme === 'dark'
              ? /import\s+["']@idux\/components\/dark\.full\.css["']/.test(mainSource)
                && /import\s+["']@idux\/pro\/dark\.full\.css["']/.test(mainSource)
              : evidence.theme === 'light' &&
                /import\s+["']@idux\/components\/default\.full\.css["']/.test(mainSource) &&
                /import\s+["']@idux\/pro\/default\.full\.css["']/.test(mainSource)
          ),
        '必须同时加载 Components/Pro 结构样式及同一套 default.full.css 或 dark.full.css 主题变量'
      ),
      result(
        'enterprise-pattern-contract',
        '页面模式、操作作用域、状态和响应式优先级结构完整',
        enterprisePatternPassed,
        traceabilityDetail ?? '应用蓝图缺少 idux-enterprise-design 页面体验契约'
      ),
      result(
        'modular-source-structure',
        '应用壳、视图与状态按职责拆分',
        modularRuntime,
        'App.vue 只能装配 Provider 与根应用壳；布局、视图和业务状态必须位于独立组件或组合式控制器'
      ),
      result(
        'idux-pro-layout',
        '应用壳使用 IDux 高级布局',
        proLayoutRuntime,
        '业务应用必须使用 @idux/pro/layout 的 IxProLayout 承载导航与内容区'
      ),
      result(
        'modal-destructive-confirmation',
        '危险操作使用 IDux 模态确认',
        modalConfirmation,
        '删除、状态流转等高风险操作必须通过 IxModal confirm 确认，不能在页面流中插入确认卡片'
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

  /** 生成不含路径字符的导出文件名。 */
  exportFileName(projectName: string, revisionLabel: string): string {
    return `${projectName}-${revisionLabel}.zip`
  }
}
