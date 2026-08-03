/**
 * business-app 完整链路冒烟测试。
 *
 * 覆盖逐问澄清、安全脱敏、多模块增量规划、参考图呈现、受控构建、双视口场景执行和确定性修复。
 */
import fs from 'node:fs'
import { businessAppArtifactAdapter } from '../src/artifacts/business-app/adapter'
import { buildBusinessApp, validateBusinessAppBuildInput } from '../src/artifacts/business-app/builder'
import type {
  BusinessApplicationBlueprint,
  BusinessAppRequirementDecision
} from '../src/artifacts/business-app/domain/model'
import { generateBusinessApp, type BusinessAppGenerationOptions } from '../src/artifacts/business-app/generator'
import { renderBlueprintSource } from '../src/artifacts/business-app/generation/renderer'
import { repairBusinessAppDraft } from '../src/artifacts/business-app/repairer'
import { analyzeBusinessAppRequirement } from '../src/artifacts/business-app/requirements/analyzer'
import { validateBuiltBusinessApp } from '../src/artifacts/business-app/validator'
import { createPreviewApp } from '../src/preview'
import { skillRegistry } from '../src/skills/registry'
import { store } from '../src/store'

/** 用于跳过通用“完整应用”两轮澄清的标准测试决策。 */
const fullDecisions: BusinessAppRequirementDecision[] = [
  { id: 'decision-delivery', questionId: 'delivery-depth', question: '交付层级', answer: '完整可交互原型', source: 'option', createdAt: 1 },
  { id: 'decision-workflow', questionId: 'core-workflows', question: '核心流程', answer: '完整管理闭环', source: 'option', createdAt: 2 }
]

/** 单次业务应用构建产生的后续断言上下文。 */
interface BuiltCase {
  projectId: string
  revisionId: string
  request: string
  blueprint: BusinessApplicationBlueprint
  draft: Awaited<ReturnType<typeof generateBusinessApp>>['draft']
  buildDurationMs: number
}

/** 从需求分析开始构建并静态验收一个业务应用测试用例。 */
async function buildCase(
  projectId: string,
  request: string,
  options: BusinessAppGenerationOptions = {},
  decisions: BusinessAppRequirementDecision[] = []
): Promise<BuiltCase> {
  const revisionId = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const workspace = store.artifactWorkspaceDir(projectId, revisionId)
  fs.mkdirSync(workspace, { recursive: true })
  const analysis = await analyzeBusinessAppRequirement(request, {
    decisions,
    currentBlueprint: options.currentBlueprint
  })
  if (analysis.clarification || analysis.contract.status !== 'ready') {
    throw new Error(`冒烟需求仍在等待澄清：${analysis.clarification?.topic ?? 'unknown'}`)
  }
  const generated = await generateBusinessApp(workspace, analysis.contract, options)
  validateBusinessAppBuildInput(generated.draft)
  const report = businessAppArtifactAdapter.validateDraft(generated.draft)
  if (report.status !== 'passed') throw new Error(JSON.stringify(report.gates, null, 2))
  store.writeArtifactDraft(projectId, revisionId, generated.draft)
  store.writeArtifactEvidence(projectId, revisionId, generated.evidence)
  const result = await buildBusinessApp(workspace, store.previewDir(projectId, revisionId))
  return { projectId, revisionId, request, blueprint: generated.blueprint, draft: generated.draft, buildDurationMs: result.durationMs }
}

/** 串行执行全部业务应用结构、安全、增量与浏览器验收用例。 */
async function main(): Promise<void> {
  skillRegistry.load()

  const escaped = renderBlueprintSource({
    schemaVersion: 2,
    app: { id: 'escape-test', name: '</script><script>alert(1)</script>', description: '<img src=x onerror=alert(1)>', theme: 'light' },
    shell: { navigation: 'side', homeModuleId: 'safe-module' },
    modules: [{ id: 'safe-module', name: '安全', description: '安全', icon: 'appstore', navigationOrder: 10, defaultViewId: 'safe-list', views: [{ id: 'safe-list', name: '列表', title: '列表', description: '列表', kind: 'list', entityId: 'safe-entity', columns: ['recordId'], fields: [], summaries: [], primaryActions: [], rowActions: [], sections: [] }], entityIds: ['safe-entity'], workflowIds: [], requirementIds: ['req-safe'] }],
    entities: [{ id: 'safe-entity', name: '安全记录', idField: 'recordId', fields: [{ key: 'recordId', label: 'ID', type: 'text', required: true }], records: [{ recordId: 'demo-1' }] }],
    workflows: [], dataContracts: [{ id: 'safe-data', entityId: 'safe-entity', mode: 'mock', operations: ['list'] }], permissions: [], acceptanceScenarios: [], requirementCoverage: { 'req-safe': ['view:safe-list'] }
  })
  if (escaped.includes('</script><script>') || escaped.includes('<img') || !escaped.includes('\\u003cscript\\u003e')) {
    throw new Error('应用蓝图源码没有安全转义模型文本')
  }

  const clarificationOne = await analyzeBusinessAppRequirement('新增一个完整的库存管理模块')
  if (!clarificationOne.clarification || clarificationOne.clarification.topic !== 'delivery-depth') {
    throw new Error('完整但模糊的需求没有先提出一个交付层级问题')
  }
  const clarificationTwo = await analyzeBusinessAppRequirement('新增一个完整的库存管理模块', {
    decisions: [fullDecisions[0]]
  })
  if (!clarificationTwo.clarification || clarificationTwo.clarification.topic !== 'core-workflows') {
    throw new Error('第一项澄清后没有逐轮提出下一个关键问题')
  }
  const secretAnalysis = await analyzeBusinessAppRequirement('新增库存模块，apiKey=sk-example-secret-123456789，服务在 10.0.0.8')
  if (/sk-example|10\.0\.0\.8/.test(JSON.stringify(secretAnalysis.contract))) {
    throw new Error('需求契约没有在进入产物前隐藏凭据或私有地址')
  }
  const connectedBoundary = await analyzeBusinessAppRequirement('连接真实库存系统并提供库存查询')
  if (connectedBoundary.clarification?.topic !== 'data-connection-boundary') {
    throw new Error('真实系统需求没有先确认数据接入与安全边界')
  }
  const connectorIdentity = await analyzeBusinessAppRequirement('连接真实库存系统并提供库存查询', {
    decisions: [{
      id: 'decision-connected', questionId: 'data-connection-boundary', question: '数据接入层级',
      answer: '连接已授权系统', source: 'option', createdAt: 3
    }]
  })
  if (connectorIdentity.clarification?.topic !== 'connector-identity') {
    throw new Error('真实系统模式没有继续确认已授权连接器')
  }

  const cloud = await buildCase('business-app-cloud-full', '新增一个完整的云主机管理模块', {}, fullDecisions)
  const quota = await buildCase('business-app-cloud-quota', '新增一个完整的配额管理模块', { currentBlueprint: cloud.blueprint }, fullDecisions)
  const users = await buildCase('business-app-cloud-quota-users', '新增一个完整的用户管理模块', { currentBlueprint: quota.blueprint }, fullDecisions)
  const referenceStyle = await buildCase(
    'business-app-reference-style',
    '生成订单查询与维护应用',
    {
      presentation: { navigation: 'top', theme: 'dark' },
      referenceAnalysis: {
        viewKind: 'list', applicationName: '订单运营平台', moduleName: '订单管理', viewTitle: '订单查询',
        description: '参考图呈现证据', navigation: 'top', navigationItems: ['订单', '客户'],
        primaryActions: ['导出'], componentRoles: ['筛选区', '数据表格'],
        sections: [{ title: '订单列表', role: '查询与维护', visibleTexts: ['订单状态'] }],
        fields: [{ label: '订单编号', role: 'identity' }, { label: '状态', role: 'status' }],
        density: 'compact', surface: 'flat', theme: 'dark', unreadable: [], redactions: [], confidence: 'high'
      },
      referenceEvidence: {
        mode: 'vision-structured-spec', analyzer: 'business-app-reference-v2', imageCount: 1,
        imageSha256: 'a'.repeat(64), analysisSha256: 'b'.repeat(64)
      }
    }
  )

  if (quota.blueprint.modules.length !== 2 || users.blueprint.modules.length !== 3) {
    throw new Error('增量业务需求没有保留原有模块')
  }
  const ambiguousModule = await analyzeBusinessAppRequirement('增加详情和编辑能力', {
    currentBlueprint: users.blueprint
  })
  if (ambiguousModule.clarification?.topic !== 'target-module') {
    throw new Error('多模块应用中的未指明变更没有逐轮确认目标模块')
  }
  const quotaTarget = await analyzeBusinessAppRequirement('增加详情和编辑能力', {
    currentBlueprint: users.blueprint,
    decisions: [{
      id: 'decision-target', questionId: 'target-module', question: '目标模块',
      answer: '配额管理', source: 'option', createdAt: 3
    }]
  })
  if (quotaTarget.contract.targetModuleIds[0] !== 'quota' || quotaTarget.contract.status !== 'ready') {
    throw new Error('目标模块确认后没有准确收敛到配额模块')
  }
  for (const app of [cloud, quota, users]) {
    if (app.blueprint.modules.some(module => module.views.length < 4)) throw new Error('完整管理模块缺少列表、创建、详情或编辑视图')
    if (app.blueprint.acceptanceScenarios.length === 0) throw new Error('业务应用缺少可执行验收场景')
  }
  if (referenceStyle.blueprint.app.theme !== 'dark' || referenceStyle.blueprint.shell.navigation !== 'top') {
    throw new Error('参考图呈现证据没有进入应用蓝图')
  }

  const brokenDraft = {
    ...cloud.draft,
    files: {
      ...cloud.draft.files,
      'src/main.ts': cloud.draft.files['src/main.ts'].replace('@idux/components/default.full.css', '@idux/components/default.css')
    }
  }
  const brokenReport = businessAppArtifactAdapter.validateDraft(brokenDraft)
  const brokenGates = brokenReport.gates.filter(gate => gate.status === 'failed')
  if (!brokenGates.some(gate => gate.id === 'idux-style-entry')) throw new Error('损坏 IDux 主题入口后静态门禁没有阻断')
  const repaired = repairBusinessAppDraft(brokenDraft, brokenGates)
  if (repaired.actions.length === 0 || businessAppArtifactAdapter.validateDraft(repaired.draft).status !== 'passed') {
    throw new Error('确定性 IDux 主题修复未通过复检')
  }

  const previewServer = await new Promise<import('node:http').Server>(resolve => {
    const server = createPreviewApp().listen(0, '127.0.0.1', () => resolve(server))
  })
  const runtimeResults: Record<string, ValidationSummary> = {}
  try {
    const address = previewServer.address()
    if (!address || typeof address === 'string') throw new Error('无法获取业务应用冒烟预览端口')
    const allCases = [cloud, quota, users, referenceStyle]
    const selectedCase = process.env.BUSINESS_APP_SMOKE_CASE
    const runtimeCases = selectedCase
      ? allCases.filter(item => item.projectId === selectedCase)
      : allCases
    if (selectedCase && runtimeCases.length === 0) throw new Error(`未知冒烟用例：${selectedCase}`)
    for (const item of runtimeCases) {
      const runtime = await validateBuiltBusinessApp(
        `http://127.0.0.1:${address.port}/preview/${item.projectId}/${item.revisionId}/index.html`,
        item.blueprint.acceptanceScenarios
      )
      const failed = runtime.gates.filter(gate => gate.status !== 'passed')
      if (failed.length) throw new Error(JSON.stringify({ project: item.projectId, failed }, null, 2))
      runtimeResults[item.projectId] = { gateCount: runtime.gates.length, scenarioCount: item.blueprint.acceptanceScenarios.length }
    }
  } finally {
    await new Promise<void>((resolve, reject) => previewServer.close(error => error ? reject(error) : resolve()))
  }

  process.stdout.write(`${JSON.stringify({
    clarificationTopics: [clarificationOne.clarification.topic, clarificationTwo.clarification.topic],
    moduleEvolution: [cloud.blueprint.modules.length, quota.blueprint.modules.length, users.blueprint.modules.length],
    runtime: runtimeResults,
    repairActions: repaired.actions
  }, null, 2)}\n`)
}

interface ValidationSummary { gateCount: number; scenarioCount: number }

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
