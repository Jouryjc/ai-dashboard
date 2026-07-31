import crypto from 'node:crypto'
import fs from 'node:fs'
import { iduxCli, type IduxEvidence } from '../../skills/idux-cli-executor'
import type { ModelSettings } from '../../wire'
import type { ArtifactDraft } from '../types'
import type {
  IduxReferenceAnalysis,
  IduxReferenceEvidence
} from './reference'
import { planIduxPageSpec } from './spec'
import {
  loadIduxStyleBundle,
  renderIduxListPage,
  type IduxStyleEvidence
} from './style-kit'

export interface IduxPageGeneration {
  draft: ArtifactDraft
  evidence: {
    schemaVersion: 1
    iduxVersion: string
    sourceCommit: string
    combinedSha256: string
    theme: 'light' | 'dark'
    queries: IduxEvidence[]
    style: IduxStyleEvidence
    reference?: IduxReferenceEvidence
  }
}

export interface IduxPageGenerationOptions {
  reference?: {
    analysis: IduxReferenceAnalysis
    evidence: IduxReferenceEvidence
  }
}

interface EvidencePayload {
  source?: {
    version?: unknown
    commit?: unknown
  }
}

function installedVersion(): string {
  const packageFile = require.resolve('@idux/components/package.json')
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string') throw new Error('无法确认服务端 IDux 运行时版本')
  return pkg.version
}

function evidenceSource(query: IduxEvidence): { version: string; commit: string } {
  const payload = query.payload as EvidencePayload
  const version = payload.source?.version
  const commit = payload.source?.commit
  if (typeof version !== 'string' || typeof commit !== 'string') {
    throw new Error(`idux-cli ${query.command} 没有返回可追溯的版本证据`)
  }
  return { version, commit }
}

function packageJson(version: string): string {
  return JSON.stringify({
    name: 'generated-idux-page',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview'
    },
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function projectFiles(
  version: string,
  title: string,
  appVue: string,
  pageCss: string,
  evidence: IduxPageGeneration['evidence']
): ArtifactDraft {
  return {
    entryFile: 'index.html',
    files: {
      'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="由 AI Dashboard 生成的 IDux 普通页面" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      'package.json': packageJson(version),
      'src/main.ts': `import { createApp } from 'vue'
import '@idux/components/index.full.css'
import '@idux/components/${evidence.theme === 'dark' ? 'dark' : 'default'}.full.css'
import App from './App.vue'

createApp(App).mount('#app')
`,
      'src/App.vue': appVue,
      'src/page-shell.css': pageCss,
      'generation-evidence.json': JSON.stringify({
        schemaVersion: 1,
        skills: ['idux-cli', 'idux-style'],
        iduxVersion: evidence.iduxVersion,
        sourceCommit: evidence.sourceCommit,
        combinedSha256: evidence.combinedSha256,
        theme: evidence.theme,
        componentQueries: evidence.queries.map(query => ({
          command: query.command,
          args: query.args,
          sha256: query.sha256,
          capturedAt: query.capturedAt
        })),
        style: evidence.style,
        ...(evidence.reference ? { reference: evidence.reference } : {})
      }, null, 2),
      'vite.config.ts': `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
})
`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          types: ['vite/client']
        },
        include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts']
      }, null, 2)
    }
  }
}

async function collectComponentEvidence(workspaceRoot: string): Promise<IduxEvidence[]> {
  // The local IDux cache uses a file lock. Keep queries sequential so evidence
  // ordering and the combined hash remain deterministic.
  const queries: IduxEvidence[] = []
  queries.push(await iduxCli.list(workspaceRoot, 'table', 'bundled'))
  queries.push(await iduxCli.info(workspaceRoot, 'table', 'props', { api: 'IxTable', version: 'bundled' }))
  queries.push(await iduxCli.demo(workspaceRoot, 'table', 'Basic', 'bundled'))
  queries.push(await iduxCli.info(workspaceRoot, 'input', 'props', { api: 'IxInput', version: 'bundled' }))
  queries.push(await iduxCli.info(workspaceRoot, 'tag', 'props', { api: 'IxTag', version: 'bundled' }))
  queries.push(await iduxCli.info(workspaceRoot, 'button', 'props', { api: 'IxButton', version: 'bundled' }))
  queries.push(await iduxCli.info(workspaceRoot, 'card', 'props', { api: 'IxCard', version: 'bundled' }))
  queries.push(await iduxCli.info(workspaceRoot, 'theme', 'props', { api: 'IxThemeProvider', version: 'bundled' }))
  return queries
}

export async function generateIduxPage(
  workspaceRoot: string,
  request: string,
  settings?: ModelSettings,
  options: IduxPageGenerationOptions = {}
): Promise<IduxPageGeneration> {
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const styleBundle = loadIduxStyleBundle()
  const queries = await collectComponentEvidence(workspaceRoot)
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
    styleBundle.evidence.iduxVersion !== runtimeVersion ||
    styleBundle.evidence.sourceCommit !== source.commit
  ) {
    throw new Error('idux-style 设计基线与 IDux 组件证据版本不一致')
  }

  const spec = await planIduxPageSpec(
    request,
    styleBundle.plannerGuidance,
    settings,
    options.reference?.analysis
  )
  const rendered = renderIduxListPage(styleBundle, spec)
  const combinedSha256 = crypto
    .createHash('sha256')
    .update([
      ...queries.map(query => query.sha256),
      styleBundle.evidence.assetsSha256,
      spec.presentation.theme,
      options.reference?.evidence.analysisSha256 ?? ''
    ].join(':'))
    .digest('hex')
  const evidence: IduxPageGeneration['evidence'] = {
    schemaVersion: 1,
    iduxVersion: source.version,
    sourceCommit: source.commit,
    combinedSha256,
    theme: spec.presentation.theme,
    queries,
    style: styleBundle.evidence,
    ...(options.reference ? { reference: options.reference.evidence } : {})
  }

  return {
    draft: projectFiles(
      runtimeVersion,
      spec.title,
      rendered.appVue,
      rendered.pageCss,
      evidence
    ),
    evidence
  }
}
