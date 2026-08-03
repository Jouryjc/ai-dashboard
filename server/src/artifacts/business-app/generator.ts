/**
 * business-app 产物生成器。
 *
 * 生成器编排需求校验、蓝图规划、IDux 证据采集和项目文件输出，不在此处硬编码具体业务页面。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { iduxCli, type IduxEvidence } from '../../skills/idux-cli-executor'
import type { ModelSettings } from '../../wire'
import type { ArtifactDraft } from '../types'
import type {
  BusinessApplicationBlueprint,
  BusinessAppChangePlan,
  BusinessAppRequirementContract
} from './domain/model'
import { validateRequirementContract } from './domain/validation'
import {
  loadBusinessAppDesignSystem,
  type BusinessAppDesignEvidence
} from './generation/design-system'
import { renderBlueprintSource, renderBusinessAppRuntime } from './generation/renderer'
import { planBusinessApplication } from './planning/planner'
import type { BusinessAppReferenceAnalysis, BusinessAppReferenceEvidence } from './reference'

/** 一次生成的完整结果，包含项目草稿、领域契约和可追溯证据。 */
export interface BusinessAppGeneration {
  draft: ArtifactDraft
  contract: BusinessAppRequirementContract
  blueprint: BusinessApplicationBlueprint
  changePlan: BusinessAppChangePlan
  evidence: {
    schemaVersion: 2
    iduxVersion: string
    sourceCommit: string
    combinedSha256: string
    theme: 'light' | 'dark'
    queries: IduxEvidence[]
    style: BusinessAppDesignEvidence
    reference?: BusinessAppReferenceEvidence
  }
}

/** 增量生成上下文和可选参考图证据。 */
export interface BusinessAppGenerationOptions {
  currentBlueprint?: BusinessApplicationBlueprint | null
  baseRevisionId?: string | null
  settings?: ModelSettings
  presentation?: {
    navigation?: 'side' | 'top'
    theme?: 'light' | 'dark'
  }
  referenceEvidence?: BusinessAppReferenceEvidence
  referenceAnalysis?: BusinessAppReferenceAnalysis
}

/** idux-cli 证据载荷中与版本追踪相关的最小结构。 */
interface EvidencePayload {
  source?: { version?: unknown; commit?: unknown }
}

const COMPONENT_API: Record<string, { component: string; api: string; demo?: string }> = {
  alert: { component: 'alert', api: 'IxAlert' },
  button: { component: 'button', api: 'IxButton' },
  card: { component: 'card', api: 'IxCard' },
  desc: { component: 'desc', api: 'IxDesc', demo: 'Basic' },
  form: { component: 'form', api: 'IxForm', demo: 'Basic' },
  input: { component: 'input', api: 'IxInput' },
  layout: { component: 'layout', api: 'IxLayout' },
  menu: { component: 'menu', api: 'IxMenu' },
  select: { component: 'select', api: 'IxSelect' },
  table: { component: 'table', api: 'IxTable', demo: 'Basic' },
  tag: { component: 'tag', api: 'IxTag' },
  textarea: { component: 'textarea', api: 'IxTextarea' },
  theme: { component: 'theme', api: 'IxThemeProvider' }
}

/** 读取当前服务端实际安装的 IDux 运行时版本。 */
function installedVersion(): string {
  const packageFile = require.resolve('@idux/components/package.json')
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string') throw new Error('无法确认服务端 IDux 运行时版本')
  return pkg.version
}

/** 从单条 idux-cli 查询结果中提取可审计版本和提交。 */
function evidenceSource(query: IduxEvidence): { version: string; commit: string } {
  const payload = query.payload as EvidencePayload
  const version = payload.source?.version
  const commit = payload.source?.commit
  if (typeof version !== 'string' || typeof commit !== 'string') {
    throw new Error(`idux-cli ${query.command} 没有返回可追溯的版本证据`)
  }
  return { version, commit }
}

/** 生成与证据版本完全一致的项目依赖清单。 */
function packageJson(version: string): string {
  return JSON.stringify({
    name: 'generated-business-application',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      '@idux/cdk': version,
      '@idux/components': version,
      vue: '3.5.13'
    },
    devDependencies: {
      '@vitejs/plugin-vue': '5.2.1',
      vite: '6.4.3'
    }
  }, null, 2)
}

/** 转义写入 HTML 元数据的业务文本。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 生成 IDux 组件、样式及参考图来源证据清单。 */
function manifestJson(generation: Omit<BusinessAppGeneration, 'draft'>): string {
  return JSON.stringify({
    schemaVersion: 2,
    skills: ['idux-cli', 'idux-style'],
    iduxVersion: generation.evidence.iduxVersion,
    sourceCommit: generation.evidence.sourceCommit,
    combinedSha256: generation.evidence.combinedSha256,
    theme: generation.evidence.theme,
    componentQueries: generation.evidence.queries.map(query => ({
      command: query.command,
      args: query.args,
      sha256: query.sha256,
      capturedAt: query.capturedAt
    })),
    style: generation.evidence.style,
    ...(generation.evidence.reference ? { reference: generation.evidence.reference } : {})
  }, null, 2)
}

/** 组装可构建项目及所有可审计契约文件。 */
function projectFiles(
  version: string,
  generation: Omit<BusinessAppGeneration, 'draft'>,
  appVue: string,
  appCss: string
): ArtifactDraft {
  const { contract, blueprint, changePlan } = generation
  return {
    entryFile: 'index.html',
    files: {
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="由 Loop Engineer 生成并验收的业务应用" />
    <title>${escapeHtml(blueprint.app.name)}</title>
  </head>
  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>
`,
      'package.json': packageJson(version),
      'src/main.ts': `import { createApp } from 'vue'
import '@idux/components/index.full.css'
import '@idux/components/${blueprint.app.theme === 'dark' ? 'dark' : 'default'}.full.css'
import App from './App.vue'

createApp(App).mount('#app')
`,
      'src/App.vue': appVue,
      'src/app/blueprint.ts': renderBlueprintSource(blueprint),
      'src/styles/app-shell.css': appCss,
      'src/contracts/requirement-contract.json': JSON.stringify(contract, null, 2),
      'src/contracts/application-blueprint.json': JSON.stringify(blueprint, null, 2),
      'src/contracts/change-plan.json': JSON.stringify(changePlan, null, 2),
      'src/contracts/acceptance-plan.json': JSON.stringify(blueprint.acceptanceScenarios, null, 2),
      'generation-evidence.json': manifestJson(generation),
      'vite.config.ts': `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({ base: './', plugins: [vue()] })
`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
          strict: true, skipLibCheck: true, types: ['vite/client']
        },
        include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts']
      }, null, 2)
    }
  }
}

/** 按变更计划收集实际使用组件的属性和示例证据。 */
async function collectComponentEvidence(
  workspaceRoot: string,
  components: string[]
): Promise<IduxEvidence[]> {
  const required = [...new Set([...components, 'theme'])]
    .map(name => COMPONENT_API[name])
    .filter((item): item is { component: string; api: string; demo?: string } => Boolean(item))
    .sort((a, b) => a.component.localeCompare(b.component))
  const queries: IduxEvidence[] = []
  for (const item of required) {
    queries.push(await iduxCli.info(workspaceRoot, item.component, 'props', {
      api: item.api,
      version: 'bundled'
    }))
    if (item.demo) queries.push(await iduxCli.demo(workspaceRoot, item.component, item.demo, 'bundled'))
  }
  return queries
}

/**
 * 根据已就绪需求契约生成完整业务应用项目。
 *
 * IDux 组件证据、设计基线和本地运行时版本必须完全一致，否则拒绝生成。
 */
export async function generateBusinessApp(
  workspaceRoot: string,
  contract: BusinessAppRequirementContract,
  options: BusinessAppGenerationOptions = {}
): Promise<BusinessAppGeneration> {
  fs.mkdirSync(workspaceRoot, { recursive: true })
  validateRequirementContract(contract)
  if (contract.status !== 'ready') throw new Error('业务应用需求尚未完成澄清，不能进入生成阶段')

  const designSystem = loadBusinessAppDesignSystem()
  const { blueprint, changePlan } = await planBusinessApplication(contract, {
    currentBlueprint: options.currentBlueprint,
    baseRevisionId: options.baseRevisionId,
    settings: options.settings,
    presentation: options.presentation,
    presentationEvidence: options.referenceAnalysis
  })
  const queries = await collectComponentEvidence(workspaceRoot, changePlan.requiredIduxComponents)
  const sources = queries.map(evidenceSource)
  const [source] = sources
  if (!source || !sources.every(item => item.version === source.version && item.commit === source.commit)) {
    throw new Error('idux-cli 返回的组件证据版本不一致')
  }
  const runtimeVersion = installedVersion()
  if (source.version !== runtimeVersion) {
    throw new Error(`IDux 证据版本 ${source.version} 与构建运行时 ${runtimeVersion} 不一致`)
  }
  if (
    designSystem.evidence.iduxVersion !== runtimeVersion ||
    designSystem.evidence.sourceCommit !== source.commit
  ) {
    throw new Error('idux-style 设计基线与 IDux 组件证据版本不一致')
  }

  const combinedSha256 = crypto.createHash('sha256').update([
    ...queries.map(query => query.sha256),
    designSystem.evidence.assetsSha256,
    crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    crypto.createHash('sha256').update(JSON.stringify(blueprint)).digest('hex'),
    options.referenceEvidence?.analysisSha256 ?? ''
  ].join(':')).digest('hex')
  const evidence: BusinessAppGeneration['evidence'] = {
    schemaVersion: 2,
    iduxVersion: source.version,
    sourceCommit: source.commit,
    combinedSha256,
    theme: blueprint.app.theme,
    queries,
    style: designSystem.evidence,
    ...(options.referenceEvidence ? { reference: options.referenceEvidence } : {})
  }
  const generation = { contract, blueprint, changePlan, evidence }
  return {
    ...generation,
    draft: projectFiles(runtimeVersion, generation, renderBusinessAppRuntime(), designSystem.css)
  }
}
