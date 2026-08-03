import fs from 'node:fs'
import { buildIduxPage, validateIduxBuildInput } from '../src/artifacts/idux-page/builder'
import { iduxPageArtifactAdapter } from '../src/artifacts/idux-page/adapter'
import {
  generateIduxPage,
  type IduxPageGenerationOptions
} from '../src/artifacts/idux-page/generator'
import { repairIduxPageDraft } from '../src/artifacts/idux-page/repairer'
import { loadIduxStyleBundle, renderIduxListPage } from '../src/artifacts/idux-page/style-kit'
import { validateBuiltIduxPage } from '../src/artifacts/idux-page/validator'
import type { IduxAcceptanceScenario } from '../src/artifacts/idux-page/spec'
import { createPreviewApp } from '../src/preview'
import { skillRegistry } from '../src/skills/registry'
import { store } from '../src/store'

interface BuiltCase {
  projectId: string
  revisionId: string
  request: string
  appSource: string
  evidence: {
    version: string
    commit: string
    hash: string
    theme: 'light' | 'dark'
    styleSkill: string
    styleViewports: string[]
  }
  buildDurationMs: number
  scenarios: IduxAcceptanceScenario[]
  evidenceCommands: string[]
}

async function buildCase(
  projectId: string,
  request: string,
  options: IduxPageGenerationOptions = {}
): Promise<BuiltCase> {
  const revisionId = `rev-${Date.now()}`
  const workspace = store.artifactWorkspaceDir(projectId, revisionId)
  fs.mkdirSync(workspace, { recursive: true })
  const generated = await generateIduxPage(workspace, request, undefined, options)
  validateIduxBuildInput(generated.draft)
  const report = iduxPageArtifactAdapter.validateDraft(generated.draft)
  if (report.status !== 'passed') throw new Error(JSON.stringify(report))
  store.writeArtifactDraft(projectId, revisionId, generated.draft)
  store.writeArtifactEvidence(projectId, revisionId, generated.evidence)
  const result = await buildIduxPage(workspace, store.previewDir(projectId, revisionId))
  return {
    projectId,
    revisionId,
    request,
    appSource: generated.draft.files['src/App.vue'],
    evidence: {
      version: generated.evidence.iduxVersion,
      commit: generated.evidence.sourceCommit,
      hash: generated.evidence.combinedSha256,
      theme: generated.evidence.theme,
      styleSkill: generated.evidence.style.skill,
      styleViewports: generated.evidence.style.viewports
    },
    buildDurationMs: result.durationMs,
    scenarios: generated.spec.acceptanceScenarios,
    evidenceCommands: generated.evidence.queries.map(query => `${query.command}:${query.args.join(':')}`)
  }
}

async function main(): Promise<void> {
  skillRegistry.load()
  const escaped = renderIduxListPage(loadIduxStyleBundle(), {
    title: '</script><script>alert(1)</script>',
    description: '验证模型文本不会逃逸 Vue 脚本边界。',
    entityName: '安全记录',
    primaryAction: '新建记录',
    presentation: {
      navigation: 'none',
      navigationItems: [],
      density: 'comfortable',
      surface: 'card',
      toolbar: 'inline',
      theme: 'light'
    },
    summaryCards: [],
    columns: [
      { key: 'name', label: '名称', type: 'text' },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'updatedAt', label: '更新时间', type: 'datetime' }
    ],
    rows: [
      { name: '<img src=x onerror=alert(1)>', status: '正常', updatedAt: '2026-07-31 09:00:00' },
      { name: '演示 B', status: '正常', updatedAt: '2026-07-31 10:00:00' },
      { name: '演示 C', status: '待处理', updatedAt: '2026-07-31 11:00:00' },
      { name: '演示 D', status: '已完成', updatedAt: '2026-07-31 12:00:00' }
    ]
  })
  if (
    escaped.appVue.includes('</script><script>alert(1)</script>') ||
    escaped.appVue.includes('<img src=x onerror=alert(1)>') ||
    !escaped.appVue.includes('\\u003cscript\\u003e')
  ) {
    throw new Error('idux-style 模板没有安全转义模型生成文本')
  }

  const repairWorkspace = store.artifactWorkspaceDir('idux-repair-check', `rev-${Date.now()}`)
  const repairSource = await generateIduxPage(
    repairWorkspace,
    '生成包含云主机相关信息的表格'
  )
  const brokenDraft = {
    ...repairSource.draft,
    files: {
      ...repairSource.draft.files,
      'src/main.ts': repairSource.draft.files['src/main.ts']
        .replace('@idux/components/default.full.css', '@idux/components/default.css')
    }
  }
  const brokenReport = iduxPageArtifactAdapter.validateDraft(brokenDraft)
  const brokenGates = brokenReport.gates.filter(gate => gate.status === 'failed')
  if (!brokenGates.some(gate => gate.id === 'idux-style-entry')) {
    throw new Error('损坏样式入口后，IDux 静态门禁没有阻断')
  }
  const evidence = JSON.parse(repairSource.draft.files['generation-evidence.json']) as {
    style: { repository: string }
  }
  evidence.style.repository = 'https://example.invalid/untrusted'
  const tamperedReport = iduxPageArtifactAdapter.validateDraft({
    ...repairSource.draft,
    files: {
      ...repairSource.draft.files,
      'generation-evidence.json': JSON.stringify(evidence)
    }
  })
  if (!tamperedReport.gates.some(gate =>
    gate.id === 'idux-style-evidence' && gate.status === 'failed'
  )) {
    throw new Error('篡改 idux-style 来源后，证据门禁没有阻断')
  }
  const repaired = repairIduxPageDraft(brokenDraft, brokenGates)
  if (
    repaired.actions.length === 0 ||
    iduxPageArtifactAdapter.validateDraft(repaired.draft).status !== 'passed'
  ) {
    throw new Error('IDux 样式入口自动修复未通过复检')
  }

  const cases = [
    await buildCase('idux-build-cloud-check', '生成包含云主机相关信息的表格'),
    await buildCase('idux-build-cloud-detail-check', '生成包含云主机相关信息的表格，并支持查看详情页面'),
    await buildCase('idux-build-generic-check', '生成订单管理列表，包含编号、客户、金额和状态'),
    await buildCase(
      'idux-build-reference-dark-check',
      '根据参考图生成包含云主机相关信息的表格',
      {
        reference: {
          analysis: {
            pagePattern: 'management-list',
            title: '云主机管理',
            description: '集中查看演示云主机的运行状态和资源信息。',
            entityName: '云主机',
            primaryAction: '创建云主机',
            navigation: 'side',
            navigationItems: ['实例管理', '镜像', '安全组'],
            summaryCards: [
              { label: '实例总数', value: '6', helper: '当前演示数据', tone: 'normal' },
              { label: '运行中', value: '4', helper: '状态正常', tone: 'success' }
            ],
            columns: [
              { label: '实例 ID', type: 'text' },
              { label: '实例名称', type: 'text' },
              { label: '状态', type: 'status' },
              { label: '地域', type: 'text' },
              { label: '规格', type: 'text' },
              { label: '公网 IP', type: 'text' },
              { label: '创建时间', type: 'datetime' }
            ],
            density: 'compact',
            surface: 'flat',
            toolbar: 'inline',
            theme: 'dark',
            visibleTexts: ['云主机列表'],
            unreadable: [],
            redactions: [],
            confidence: 'high'
          },
          evidence: {
            mode: 'vision-structured-spec',
            analyzer: 'idux-page-reference-v1',
            imageCount: 1,
            imageSha256: 'a'.repeat(64),
            analysisSha256: 'b'.repeat(64)
          }
        }
      }
    )
  ]
  if (
    !cases[0].appSource.includes('"title": "云主机管理"') ||
    !cases[1].appSource.includes('"enabled": true') ||
    !cases[1].appSource.includes('data-testid="detail-view"') ||
    !cases[1].evidenceCommands.some(command => command.includes('desc')) ||
    !cases[2].appSource.includes('"title": "订单管理"') ||
    cases.slice(0, 3).some(item =>
      item.evidence.styleSkill !== 'idux-style' ||
      JSON.stringify(item.evidence.styleViewports) !== JSON.stringify(['1920x1080', '1366x768'])
    ) ||
    cases[3].evidence.theme !== 'dark' ||
    !cases[3].appSource.includes('"navigation": "side"')
  ) {
    throw new Error('受控页面规格或 idux-style 双视口证据没有生效')
  }

  const previewServer = await new Promise<import('node:http').Server>(resolve => {
    const server = createPreviewApp().listen(0, '127.0.0.1', () => resolve(server))
  })
  const runtimeResults: Record<string, unknown> = {}
  try {
    const address = previewServer.address()
    if (!address || typeof address === 'string') throw new Error('无法获取 IDux 冒烟预览端口')
    for (const item of cases) {
      const runtime = await validateBuiltIduxPage(
        `http://127.0.0.1:${address.port}/preview/${item.projectId}/${item.revisionId}/index.html`,
        item.scenarios
      )
      if (runtime.gates.some(gate => gate.status !== 'passed')) {
        throw new Error(JSON.stringify(runtime.gates))
      }
      runtimeResults[item.projectId] = runtime.gates
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      previewServer.close(error => error ? reject(error) : resolve())
    )
  }

  process.stdout.write(`${JSON.stringify({
    repairLoop: {
      detectedGateIds: brokenGates.map(gate => gate.id),
      actions: repaired.actions,
      securityChecks: ['template-json-escaping', 'style-provenance-tamper']
    },
    cases: cases.map(({ appSource: _source, ...item }) => item),
    runtime: runtimeResults
  }, null, 2)}\n`)
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
