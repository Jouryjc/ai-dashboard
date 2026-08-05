/**
 * 业务应用需求分析器。
 *
 * 先用确定性规则识别范围、数据和安全边界，再允许模型补充领域能力；任何阻塞未知项
 * 每轮只转换成一个澄清问题。敏感信息在写入需求契约前统一脱敏。
 */
import crypto from 'node:crypto'
import * as gw from '../../../gateway'
import { prompt } from '../../../prompts'
import type { ModelSettings } from '../../../wire'
import type { BusinessApplicationBlueprint } from '../domain/model'
import type {
  BusinessAppBlockingUnknown,
  BusinessAppClarificationOption,
  BusinessAppClarificationTurn,
  BusinessAppDataMode,
  BusinessAppRequirementCapability,
  BusinessAppRequirementContract,
  BusinessAppRequirementDecision
} from '../domain/model'
import { validateRequirementContract } from '../domain/validation'
import { loadBusinessAppEnterpriseDesign } from '../generation/enterprise-design'

/** 一轮需求分析的结果：需求契约，以及至多一个待回答问题。 */
export interface BusinessAppRequirementAnalysis {
  contract: BusinessAppRequirementContract
  clarification: BusinessAppClarificationTurn | null
}

/** 需求分析上下文，包含历史决策、当前应用和可选模型配置。 */
export interface AnalyzeBusinessAppRequirementOptions {
  decisions?: BusinessAppRequirementDecision[]
  currentBlueprint?: BusinessApplicationBlueprint | null
  settings?: ModelSettings
}

const ACTION_PATTERNS: Array<{ pattern: RegExp; id: string; name: string; description: string }> = [
  { pattern: /列表|查询|搜索|筛选|查看|管理/, id: 'manage-records', name: '记录管理', description: '查看、搜索和筛选业务记录' },
  { pattern: /创建|新增|新建|添加|录入/, id: 'create-record', name: '创建业务对象', description: '通过完整表单或向导创建业务对象' },
  { pattern: /详情|明细/, id: 'view-detail', name: '查看详情', description: '查看所选业务对象的完整信息' },
  { pattern: /编辑|修改|配置/, id: 'edit-record', name: '编辑业务对象', description: '修改并保存业务对象信息' },
  { pattern: /删除|移除|注销/, id: 'delete-record', name: '删除业务对象', description: '确认后删除或注销业务对象' },
  { pattern: /审批|审核|流转/, id: 'approval-workflow', name: '审批流转', description: '按业务状态执行审批或审核' },
  { pattern: /启停|启动|停止|重启|状态/, id: 'state-transition', name: '状态操作', description: '执行受控状态流转并反馈结果' }
]

/** 根据稳定内容生成可重复的短 ID，保证恢复后需求引用不漂移。 */
function stableId(prefix: string, value: string): string {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 10)}`
}

/** 清除密钥、令牌、密码和私网地址，避免它们进入契约或生成产物。 */
function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [已隐藏令牌]')
    .replace(/((?:password|passwd|secret|token|api[_ -]?key|密码|密钥)\s*[:：=]\s*)\S+/gi, '$1[已隐藏]')
    .replace(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, '[已隐藏私有地址]')
}

/** 将用户描述转换成领域安全 ID；中文名称无法直转时使用稳定哈希。 */
function normalizeModuleId(value: string): string {
  const direct = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (/^[a-z][a-z0-9-]{0,63}$/.test(direct)) return direct
  if (/云主机|云服务器|ecs/i.test(value)) return 'cloud-host'
  if (/配额/.test(value)) return 'quota'
  if (/用户|账号/.test(value)) return 'user-management'
  if (/角色|权限/.test(value)) return 'role-permission'
  if (/订单|交易/.test(value)) return 'order-management'
  if (/审批|审核/.test(value)) return 'approval'
  return `module-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}`
}

/** 从本轮需求中提取面向用户的模块名称。 */
function moduleName(request: string): string {
  const known = [
    /云主机|云服务器|ECS/i,
    /配额/,
    /用户(?:管理)?|账号(?:管理)?/,
    /角色(?:管理)?|权限(?:管理)?/,
    /订单(?:管理)?|交易(?:管理)?/,
    /审批(?:管理)?|审核(?:管理)?/
  ].map(pattern => pattern.exec(request)?.[0]).find(Boolean)
  if (known) return known.replace(/管理$/u, '')
  const match = /(?:新增|创建|开发|增加|添加|修改|完善)?\s*([\p{Script=Han}A-Za-z0-9_-]{2,16}?)(?:管理)?(?:模块|功能|应用|页面)/u.exec(request)
  return match?.[1] || '业务记录'
}

/** 按时间倒序读取某个澄清主题的最新答案。 */
function decisionAnswer(decisions: BusinessAppRequirementDecision[], topic: string): string | null {
  return [...decisions].reverse().find(item => item.questionId === topic || item.id === topic)?.answer ?? null
}

/** 根据明确需求和已确认决策推断数据交付模式。 */
function inferDataMode(request: string, decisions: BusinessAppRequirementDecision[]): BusinessAppDataMode {
  const answer = decisionAnswer(decisions, 'delivery-depth') ?? decisionAnswer(decisions, 'data-mode') ?? ''
  const source = `${request}\n${answer}`
  if (/真实|连接|接入.*(?:接口|系统|API)|生产/.test(source)) return 'connected'
  if (/可对接|接口契约|前端工程|contract/i.test(source)) return 'contract'
  return 'mock'
}

/** 判断用户是否已经明确给出足够完整的记录级任务范围。 */
function explicitWorkflowScope(source: string): boolean {
  // “新增一个……管理模块”同时命中“新增”和“管理”，但仍没有说明
  // 记录级创建、详情、维护和删除等真实任务边界。至少三个明确任务才
  // 视为用户已经自行给出了足够完整的流程范围。
  return ACTION_PATTERNS.filter(item => item.pattern.test(source)).length >= 3
}

/** 把需求中的业务动词转换成规划器可消费的能力清单。 */
function workflowCapabilities(request: string, decisions: BusinessAppRequirementDecision[]): BusinessAppRequirementCapability[] {
  const decisionText = decisions.map(item => item.answer).join('；')
  const source = `${request}；${decisionText}`
  const matches = ACTION_PATTERNS.filter(item => item.pattern.test(source))
  const completeRequested = /完整|全套|全面/.test(source)
  const selected = matches.length > 0
    ? matches
    : [{ pattern: /.*/, id: 'manage-records', name: '记录管理', description: '查看、搜索和筛选业务记录' }]
  if (completeRequested && decisionAnswer(decisions, 'core-workflows')) {
    for (const action of ACTION_PATTERNS.slice(0, 5)) {
      if (!selected.some(item => item.id === action.id)) selected.push(action)
    }
  }
  return selected.map(item => ({
    id: `req-${item.id}`,
    name: item.name,
    description: item.description,
    priority: 'must' as const
  }))
}

/** 创建格式统一的澄清候选项。 */
function option(
  id: string,
  title: string,
  consequence: string,
  recommended = false,
  recommendReason: string | null = null,
  riskLevel: BusinessAppClarificationOption['riskLevel'] = 'low'
): BusinessAppClarificationOption {
  return { id, title, consequence, recommended, recommendReason, riskLevel }
}

/** 构造交付深度澄清问题。 */
function deliveryQuestion(): BusinessAppClarificationTurn {
  return {
    id: stableId('clarify', 'delivery-depth'),
    intro: '先确认这次业务应用要交付到什么程度',
    question: '你希望这次生成的业务应用做到哪一层？',
    topic: 'delivery-depth',
    allowCustomInput: true,
    options: [
      option(
        'interactive-prototype',
        '完整可交互原型',
        '使用安全演示数据，页面、表单和主要业务流程都可以实际操作',
        true,
        '能完整验证需求和体验，同时不会误操作真实业务系统'
      ),
      option('integration-ready', '可对接工程', '生成完整交互、数据契约、加载和异常状态，后续接入真实接口'),
      option('connected-system', '连接真实系统', '需要继续确认接口、权限、凭据和操作安全边界', false, null, 'high')
    ]
  }
}

/** 构造核心工作流范围澄清问题。 */
function workflowQuestion(name: string): BusinessAppClarificationTurn {
  return {
    id: stableId('clarify', `core-workflows:${name}`),
    intro: `再确认${name}模块必须完成的核心任务`,
    question: `这次${name}模块的“完整”主要包含哪些业务流程？`,
    topic: 'core-workflows',
    allowCustomInput: true,
    options: [
      option(
        'full-management',
        '完整管理闭环',
        '包含概览、列表、搜索、创建、详情、编辑、删除或状态操作',
        true,
        '可以形成可验证的日常管理闭环'
      ),
      option('query-and-maintain', '查询与维护', '包含列表、搜索、详情和编辑，不提供创建或删除'),
      option('query-only', '只读查询', '只提供概览、列表、筛选和详情，不改变任何数据')
    ]
  }
}

/** 构造真实数据接入边界澄清问题。 */
function dataConnectionQuestion(): BusinessAppClarificationTurn {
  return {
    id: stableId('clarify', 'data-connection-boundary'),
    intro: '真实数据接入会改变权限和安全边界，先确认本次交付范围',
    question: '这次业务应用的数据接入做到哪一层？',
    topic: 'data-connection-boundary',
    allowCustomInput: true,
    options: [
      option('contract-ready', '接口契约与安全适配层', '完成全部交互、加载/空/异常状态和接口契约，但不携带凭据连接生产系统', true, '能验证完整业务流程，同时避免未经授权访问真实数据'),
      option('safe-mock', '安全演示数据', '使用明确标识的虚构数据完成可交互原型'),
      option('authorized-connector', '连接已授权系统', '还需要继续确认已配置连接器 ID、权限和高风险操作边界', false, null, 'high')
    ]
  }
}

/** 构造已授权连接器身份澄清问题。 */
function connectorQuestion(): BusinessAppClarificationTurn {
  return {
    id: stableId('clarify', 'connector-identity'),
    intro: '连接真实系统前必须绑定已经授权的连接器，凭据不会写入生成代码',
    question: '请在自定义回答中提供已配置连接器 ID（格式：connector:your-connector-id），或者改为接口契约交付。',
    topic: 'connector-identity',
    allowCustomInput: true,
    options: [
      option('contract-instead', '改为接口契约交付', '保留完整交互和接口边界，本次不连接真实系统', true, '不会因缺少授权连接器阻塞业务验证'),
      option('safe-mock-instead', '改用安全演示数据', '使用明确标识的虚构数据完成完整交互，本次不连接真实系统')
    ]
  }
}

/** 从请求和历史回答中提取格式受控的连接器 ID。 */
function connectorId(request: string, decisions: BusinessAppRequirementDecision[]): string | null {
  const source = `${request}\n${decisions.map(item => item.answer).join('\n')}`
  return /connector\s*[:：=]\s*([a-z][a-z0-9-]{1,63})/i.exec(source)?.[1]?.toLowerCase() ?? null
}

/** 多模块应用无法定位改动时，按导航顺序提供目标模块选择。 */
function targetModuleQuestion(blueprint: BusinessApplicationBlueprint): BusinessAppClarificationTurn {
  const candidates = [...blueprint.modules].sort((a, b) => a.navigationOrder - b.navigationOrder).slice(0, 3)
  return {
    id: stableId('clarify', 'target-module'),
    intro: '当前应用有多个模块，这项变更没有说明落在哪个模块',
    question: '这次修改针对哪个业务模块？',
    topic: 'target-module',
    allowCustomInput: true,
    options: candidates.map((module, index) => option(
      module.id,
      module.name,
      `只修改${module.name}及其回归场景，其他模块保持不变`,
      index === 0,
      index === 0 ? '默认选择导航顺序中的首个相关模块；如不符合请改选或自定义' : null
    ))
  }
}

/**
 * 通过确定性规则生成需求契约。
 *
 * 阻塞条件按安全与影响优先级串行判断，因此一次调用最多产生一个澄清问题。
 */
function deterministicAnalysis(
  request: string,
  decisions: BusinessAppRequirementDecision[],
  currentBlueprint: BusinessApplicationBlueprint | null
): BusinessAppRequirementAnalysis {
  const hasCurrentApp = Boolean(currentBlueprint?.modules.length)
  const namedCurrentModule = currentBlueprint?.modules.find(module =>
    request.toLowerCase().includes(module.id.toLowerCase()) || request.includes(module.name)
  )
  const targetDecision = decisionAnswer(decisions, 'target-module')
  const decidedModule = targetDecision
    ? currentBlueprint?.modules.find(module => targetDecision.includes(module.id) || targetDecision.includes(module.name))
    : null
  const knownDomainMentioned = /云主机|云服务器|ecs|配额|用户|账号|角色|权限|订单|交易|审批|审核/i.test(request)
  const moduleLevelAddition = /(?:新增|创建|增加|添加|开发).{0,12}(?:模块|应用)/.test(request)
  const inferredExistingModule = !knownDomainMentioned && !moduleLevelAddition && currentBlueprint?.modules.length === 1
    ? currentBlueprint.modules[0]
    : null
  const targetModule = namedCurrentModule ?? decidedModule ?? inferredExistingModule
  const name = targetModule?.name ?? moduleName(request)
  const moduleId = targetModule?.id ?? normalizeModuleId(name)
  const operation = hasCurrentApp
    ? currentBlueprint!.modules.some(module => module.id === moduleId)
      ? 'change-module' as const
      : 'add-module' as const
    : 'create-app' as const
  const completeRequested = /完整|全套|全面/.test(request)
  const deliveryAnswer = decisionAnswer(decisions, 'delivery-depth')
  const workflowAnswer = decisionAnswer(decisions, 'core-workflows')
  const connectionAnswer = decisionAnswer(decisions, 'data-connection-boundary')
  const inferredMode = inferDataMode(request, decisions)
  const blockingUnknowns: BusinessAppBlockingUnknown[] = []
  let clarification: BusinessAppClarificationTurn | null = null

  if (
    hasCurrentApp &&
    currentBlueprint!.modules.length > 1 &&
    !knownDomainMentioned &&
    !moduleLevelAddition &&
    !targetModule
  ) {
    blockingUnknowns.push({ id: 'unknown-target-module', topic: 'target-module', reason: '多模块应用中的变更目标不明确', impact: 'scope', priority: 130 })
    clarification = targetModuleQuestion(currentBlueprint!)
  } else if (inferredMode === 'connected' && !connectionAnswer && /真实|生产|连接|接入/.test(request)) {
    blockingUnknowns.push({ id: 'unknown-data-connection-boundary', topic: 'data-connection-boundary', reason: '真实数据接入范围和授权边界尚未确认', impact: 'safety', priority: 120 })
    clarification = dataConnectionQuestion()
  } else if (inferredMode === 'connected' && !connectorId(request, decisions)) {
    blockingUnknowns.push({ id: 'unknown-connector-identity', topic: 'connector-identity', reason: '真实数据模式缺少已授权连接器 ID', impact: 'permission', priority: 110 })
    clarification = connectorQuestion()
  } else if (completeRequested && !deliveryAnswer && !/(?:演示|原型|可对接|真实|接口契约)/.test(request)) {
    blockingUnknowns.push({
      id: 'unknown-delivery-depth',
      topic: 'delivery-depth',
      reason: '“完整”没有说明是交互原型、可对接工程还是连接真实系统',
      impact: 'data',
      priority: 100
    })
    clarification = deliveryQuestion()
  } else if (completeRequested && !workflowAnswer && !explicitWorkflowScope(request)) {
    blockingUnknowns.push({
      id: 'unknown-core-workflows',
      topic: 'core-workflows',
      reason: '“完整”没有明确核心业务任务边界',
      impact: 'workflow',
      priority: 90
    })
    clarification = workflowQuestion(name)
  }

  const capabilities = workflowCapabilities(request, decisions)
  const requirementId = stableId('req', `${moduleId}:${request}`)
  const acceptanceCriteria = capabilities.map((capability, index) => ({
    id: `${requirementId}-ac-${index + 1}`,
    requirementId,
    description: capability.description,
    expectedOutcome: `${capability.name}可以在 1920×1080 与 1366×768 中完成并得到可验证结果`
  }))
  const contract: BusinessAppRequirementContract = {
    schemaVersion: 1,
    goal: redactSensitiveText(request.trim()) || `生成${name}业务模块`,
    operation,
    targetModuleIds: [moduleId],
    actors: ['业务操作人员'],
    capabilities,
    dataMode: inferredMode,
    permissions: capabilities.some(item => /删除|状态|审批/.test(item.name)) ? ['业务操作权限'] : ['业务查看权限'],
    constraints: ['使用 Vue 3 与 IDux', '支持 1920×1080 与 1366×768', '准确性、体验性和安全性不可降级'],
    assumptions: [
      ...(inferredMode === 'mock' ? ['预览使用明确标识的安全演示数据'] : []),
      ...(connectorId(request, decisions) ? [`已授权连接器：${connectorId(request, decisions)}`] : [])
    ],
    decisions: decisions.map(decision => ({ ...decision, answer: redactSensitiveText(decision.answer) })),
    blockingUnknowns,
    acceptanceCriteria,
    status: blockingUnknowns.length === 0 ? 'ready' : 'clarifying'
  }
  validateRequirementContract(contract)
  return { contract, clarification }
}

/** 压缩当前蓝图，只向需求模型暴露模块与视图结构。 */
function compactBlueprint(blueprint: BusinessApplicationBlueprint | null): string {
  if (!blueprint) return '当前还没有业务应用蓝图。'
  return JSON.stringify({
    app: blueprint.app,
    modules: blueprint.modules.map(module => ({
      id: module.id,
      name: module.name,
      views: module.views.map(view => ({ id: view.id, name: view.name, kind: view.kind }))
    }))
  }, null, 2)
}

/**
 * 规范化模型补充结果。
 *
 * 确定性阻塞问题具有最高优先级；模型只能补充能力或提出一个新的合法问题，不能删除
 * 安全边界、覆盖确认决策或绕过领域校验。
 */
function normalizeModelContract(
  raw: unknown,
  request: string,
  decisions: BusinessAppRequirementDecision[],
  currentBlueprint: BusinessApplicationBlueprint | null
): BusinessAppRequirementAnalysis {
  const fallback = deterministicAnalysis(request, decisions, currentBlueprint)
  if (!raw || typeof raw !== 'object') return fallback
  const value = raw as { contract?: unknown; clarification?: unknown }
  if (!value.contract || typeof value.contract !== 'object') return fallback
  const candidate = value.contract as Partial<BusinessAppRequirementContract>
  const rawCapabilities = Array.isArray(candidate.capabilities) ? candidate.capabilities : []
  const modelCapabilities: BusinessAppRequirementCapability[] = rawCapabilities.slice(0, 12).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const capability = item as unknown as Record<string, unknown>
    const name = typeof capability.name === 'string' ? capability.name.trim().slice(0, 40) : ''
    const description = typeof capability.description === 'string' ? capability.description.trim().slice(0, 160) : ''
    if (!name || !description) return []
    const priority = capability.priority === 'should' || capability.priority === 'could'
      ? capability.priority
      : 'must'
    return [{ id: stableId('req-capability', `${index}:${name}`), name, description, priority }]
  })
  const capabilities = [...fallback.contract.capabilities]
  for (const capability of modelCapabilities) {
    if (!capabilities.some(item => item.name === capability.name)) capabilities.push(capability)
  }
  const requirementId = fallback.contract.acceptanceCriteria[0]?.requirementId ?? stableId('req', request)
  const contract: BusinessAppRequirementContract = {
    ...fallback.contract,
    goal: typeof candidate.goal === 'string' && candidate.goal.trim() ? candidate.goal.trim() : fallback.contract.goal,
    actors: Array.isArray(candidate.actors) ? candidate.actors.filter((item): item is string => typeof item === 'string').slice(0, 8) : fallback.contract.actors,
    permissions: Array.isArray(candidate.permissions) ? candidate.permissions.filter((item): item is string => typeof item === 'string').slice(0, 12) : fallback.contract.permissions,
    assumptions: Array.isArray(candidate.assumptions) ? candidate.assumptions.filter((item): item is string => typeof item === 'string').slice(0, 12) : fallback.contract.assumptions,
    capabilities,
    acceptanceCriteria: capabilities.map((capability, index) => ({
      id: `${requirementId}-ac-${index + 1}`,
      requirementId,
      description: capability.description,
      expectedOutcome: `${capability.name}可以通过实际操作完成，并在两个目标视口中得到可验证结果`
    })),
    decisions: decisions.map(decision => ({ ...decision, answer: redactSensitiveText(decision.answer) }))
  }
  // 确定性阻塞问题具有权威性：模型可以丰富已就绪契约，但不能静默删除高影响未知项。
  if (fallback.contract.blockingUnknowns.length > 0) return fallback
  const rawClarification = value.clarification
  if (rawClarification && typeof rawClarification === 'object') {
    const item = rawClarification as Record<string, unknown>
    const topic = typeof item.topic === 'string'
      ? item.topic.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
      : ''
    const question = typeof item.question === 'string' ? item.question.trim().slice(0, 160) : ''
    const intro = typeof item.intro === 'string' ? item.intro.trim().slice(0, 100) : '还需要确认一个关键业务边界'
    const rawOptions = Array.isArray(item.options) ? item.options : []
    const options = rawOptions.slice(0, 3).flatMap((rawOption, index) => {
      if (!rawOption || typeof rawOption !== 'object') return []
      const optionValue = rawOption as Record<string, unknown>
      const title = typeof optionValue.title === 'string' ? optionValue.title.trim().slice(0, 40) : ''
      const consequence = typeof optionValue.consequence === 'string' ? optionValue.consequence.trim().slice(0, 140) : ''
      if (!title || !consequence) return []
      // 选项必须直接回答当前问题；“描述/填写/选择模板”等下一步动作会被 UI
      // 当成最终答案，造成用户点过确认后仍然缺少真正的业务语义。
      if (/^(?:描述|填写|输入|提供|补充|说明)|模板|稍后|后续再/u.test(`${title} ${consequence}`)) return []
      return [option(
        typeof optionValue.id === 'string' ? normalizeModuleId(optionValue.id) : `option-${index + 1}`,
        title,
        consequence,
        optionValue.recommended === true,
        typeof optionValue.recommendReason === 'string' ? optionValue.recommendReason.trim().slice(0, 100) : null,
        optionValue.riskLevel === 'high' || optionValue.riskLevel === 'medium' ? optionValue.riskLevel : 'low'
      )]
    })
    const alreadyDecided = Boolean(topic && decisionAnswer(decisions, topic))
    if (topic && question && options.length >= 2 && !alreadyDecided) {
      if (options.filter(item => item.recommended).length !== 1) {
        options.forEach((item, index) => {
          item.recommended = index === 0
          item.recommendReason = index === 0 ? item.recommendReason || '这是可逆且风险较低的默认选择' : null
        })
      }
      contract.blockingUnknowns = [{
        id: stableId('unknown', topic),
        topic,
        reason: question,
        impact: item.impact === 'scope' || item.impact === 'data' || item.impact === 'permission' || item.impact === 'safety'
          ? item.impact
          : 'workflow',
        priority: 80
      }]
      contract.status = 'clarifying'
      validateRequirementContract(contract)
      return {
        contract,
        clarification: {
          id: stableId('clarify', topic), intro, question, topic, options, allowCustomInput: true
        }
      }
    }
  }
  contract.blockingUnknowns = []
  contract.status = 'ready'
  contract.dataMode = candidate.dataMode === 'mock' || candidate.dataMode === 'contract' || candidate.dataMode === 'connected'
    ? candidate.dataMode
    : fallback.contract.dataMode
  validateRequirementContract(contract)
  return { contract, clarification: null }
}

/**
 * 分析一轮用户需求。
 *
 * 有阻塞问题时直接返回确定性结果；需求已完整时再调用模型补充任意领域能力，模型异常
 * 自动回退确定性契约，保证 Loop 可以继续运行。
 */
export async function analyzeBusinessAppRequirement(
  request: string,
  options: AnalyzeBusinessAppRequirementOptions = {}
): Promise<BusinessAppRequirementAnalysis> {
  const decisions = options.decisions ?? []
  const currentBlueprint = options.currentBlueprint ?? null
  const deterministic = deterministicAnalysis(request, decisions, currentBlueprint)
  if (deterministic.clarification || !options.settings?.apiBase || !options.settings.model) {
    return deterministic
  }
  try {
    const enterpriseDesign = loadBusinessAppEnterpriseDesign()
    const reply = await gw.chatCompletion(options.settings, {
      role: 'planner',
      temperature: 0,
      maxTokens: 1800,
      messages: [
        {
          role: 'system',
          content: `${prompt('business-app-requirements.system')}\n\n以下是 idux-enterprise-design 的需求阶段约束：\n${enterpriseDesign.requirementsGuidance}`
        },
        {
          role: 'user',
          content: prompt('business-app-requirements.user', {
            request,
            decisions: JSON.stringify(decisions, null, 2),
            currentBlueprint: compactBlueprint(currentBlueprint)
          })
        }
      ]
    })
    return normalizeModelContract(gw.extractJson(reply), request, decisions, currentBlueprint)
  } catch {
    return deterministic
  }
}
