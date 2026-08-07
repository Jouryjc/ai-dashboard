/**
 * business-app 领域契约校验器。
 *
 * 校验在模型输出进入生成器前执行，负责阻止悬空引用、越权数据连接、危险操作漏确认
 * 以及需求没有验收场景等结构性问题。
 */
import type {
  BusinessApplicationBlueprint,
  BusinessAppAcceptanceScenario,
  BusinessAppActionDefinition,
  BusinessAppChangePlan,
  BusinessAppEntityDefinition,
  BusinessAppFieldDefinition,
  BusinessAppModuleDefinition,
  BusinessAppRequirementContract,
  BusinessAppViewDefinition
} from './model'

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/
const SAFE_FIELD = /^[a-z][A-Za-z0-9]{0,63}$/

/** 在类型系统之外执行运行时断言，并保留明确的中文失败原因。 */
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** 校验一组领域对象的 ID 格式与唯一性。 */
function uniqueIds<T extends { id: string }>(items: T[], label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    invariant(SAFE_ID.test(item.id), `${label} ID 不合法：${item.id}`)
    invariant(!seen.has(item.id), `${label} ID 重复：${item.id}`)
    seen.add(item.id)
  }
}

/** 校验字段键、显示名称及选择项约束。 */
function validateField(field: BusinessAppFieldDefinition): void {
  invariant(SAFE_FIELD.test(field.key), `字段 key 不合法：${field.key}`)
  invariant(field.label.trim().length > 0, `字段 ${field.key} 缺少名称`)
  if (field.type === 'select') {
    invariant(Array.isArray(field.options) && field.options.length >= 2, `选择字段 ${field.key} 至少需要两个选项`)
  }
}

/** 校验实体字段、主键和演示记录之间的一致性。 */
function validateEntity(entity: BusinessAppEntityDefinition): void {
  invariant(entity.name.trim().length > 0, `实体 ${entity.id} 缺少名称`)
  invariant(entity.fields.length > 0, `实体 ${entity.id} 没有字段`)
  const fieldKeys = new Set<string>()
  for (const field of entity.fields) {
    validateField(field)
    invariant(!fieldKeys.has(field.key), `实体 ${entity.id} 字段重复：${field.key}`)
    fieldKeys.add(field.key)
  }
  invariant(fieldKeys.has(entity.idField), `实体 ${entity.id} 的标识字段不存在`)
  for (const [index, record] of entity.records.entries()) {
    invariant(record && typeof record === 'object', `实体 ${entity.id} 第 ${index + 1} 条演示数据不合法`)
    invariant(entity.idField in record, `实体 ${entity.id} 第 ${index + 1} 条演示数据缺少标识`)
  }
}

/** 校验操作引用、权限引用及高风险删除保护。 */
function validateAction(
  action: BusinessAppActionDefinition,
  viewIds: Set<string>,
  permissionIds: Set<string>
): void {
  invariant(action.label.trim().length > 0, `操作 ${action.id} 缺少名称`)
  invariant(action.expectedResult.trim().length > 0, `操作 ${action.id} 缺少可验证结果`)
  if (action.targetViewId) invariant(viewIds.has(action.targetViewId), `操作 ${action.id} 指向不存在的视图`)
  if (action.requiredPermission) {
    invariant(permissionIds.has(action.requiredPermission), `操作 ${action.id} 使用了不存在的权限`)
  }
  if (action.kind === 'delete') {
    invariant(action.risk === 'high', `删除操作 ${action.id} 必须标记为高风险`)
    invariant(action.requiresConfirmation, `删除操作 ${action.id} 必须二次确认`)
  }
  if (action.scope === 'bulk') invariant(action.requiresConfirmation, `批量操作 ${action.id} 必须确认影响范围`)
}

/** 校验视图引用的实体和所有页面操作。 */
function validateView(
  view: BusinessAppViewDefinition,
  entityIds: Set<string>,
  viewIds: Set<string>,
  permissionIds: Set<string>
): void {
  invariant(view.name.trim().length > 0 && view.title.trim().length > 0, `视图 ${view.id} 缺少名称或标题`)
  invariant(view.experience.responsivePriority.length > 0, `视图 ${view.id} 缺少响应式信息优先级`)
  invariant(view.experience.states.includes('ready'), `视图 ${view.id} 缺少 ready 状态`)
  invariant(new Set(view.experience.states).size === view.experience.states.length, `视图 ${view.id} 状态重复`)
  if (view.experience.pattern.startsWith('collection-')) {
    invariant(Boolean(view.experience.collection), `集合视图 ${view.id} 缺少集合交互契约`)
    invariant(view.kind === 'list', `集合模式 ${view.id} 必须使用 list 语义视图`)
  }
  if (view.kind === 'list') {
    invariant(view.experience.states.includes('empty'), `列表视图 ${view.id} 缺少空状态`)
    invariant(view.experience.states.includes('no-results'), `列表视图 ${view.id} 缺少筛选无结果状态`)
    invariant(view.experience.states.includes('error'), `列表视图 ${view.id} 缺少错误状态`)
  }
  if (view.entityId) invariant(entityIds.has(view.entityId), `视图 ${view.id} 使用了不存在的实体`)
  for (const action of [...view.primaryActions, ...view.rowActions]) {
    validateAction(action, viewIds, permissionIds)
  }
}

/** 校验模块内部视图以及实体、工作流引用。 */
function validateModule(
  module: BusinessAppModuleDefinition,
  entityIds: Set<string>,
  workflowIds: Set<string>,
  permissionIds: Set<string>
): void {
  invariant(module.name.trim().length > 0, `模块 ${module.id} 缺少名称`)
  invariant(module.views.length > 0, `模块 ${module.id} 没有视图`)
  uniqueIds(module.views, `模块 ${module.id} 的视图`)
  const viewIds = new Set(module.views.map(view => view.id))
  invariant(viewIds.has(module.defaultViewId), `模块 ${module.id} 的默认视图不存在`)
  for (const entityId of module.entityIds) invariant(entityIds.has(entityId), `模块 ${module.id} 使用了不存在的实体`)
  for (const workflowId of module.workflowIds) invariant(workflowIds.has(workflowId), `模块 ${module.id} 使用了不存在的工作流`)
  for (const view of module.views) validateView(view, entityIds, viewIds, permissionIds)
}

/** 校验验收步骤引用的视图、操作、字段和需求均真实存在。 */
function validateScenario(
  scenario: BusinessAppAcceptanceScenario,
  modules: BusinessAppModuleDefinition[],
  entities: BusinessAppEntityDefinition[],
  requirementIds: Set<string>
): void {
  const module = modules.find(item => item.id === scenario.moduleId)
  invariant(module, `验收场景 ${scenario.id} 指向不存在的模块`)
  invariant(scenario.steps.length > 0, `验收场景 ${scenario.id} 没有步骤`)
  invariant(scenario.viewportProfiles.length > 0, `验收场景 ${scenario.id} 没有视口`)
  for (const requirementId of scenario.requirementIds) {
    invariant(requirementIds.has(requirementId), `验收场景 ${scenario.id} 引用了未覆盖的需求 ${requirementId}`)
  }
  const views = new Map(module.views.map(view => [view.id, view]))
  const actions = new Map(module.views.flatMap(view => [...view.primaryActions, ...view.rowActions]).map(action => [action.id, action]))
  const fields = new Set(
    entities.filter(entity => module.entityIds.includes(entity.id)).flatMap(entity => entity.fields.map(field => field.key))
  )
  for (const step of scenario.steps) {
    if (step.kind === 'navigate' || step.kind === 'assert-view') {
      invariant(views.has(step.viewId), `验收场景 ${scenario.id} 引用了不存在的视图 ${step.viewId}`)
    }
    if (step.kind === 'click-action') {
      invariant(actions.has(step.actionId), `验收场景 ${scenario.id} 引用了不存在的操作 ${step.actionId}`)
    }
    if (step.kind === 'fill-form') {
      for (const field of Object.keys(step.values)) invariant(fields.has(field), `验收场景 ${scenario.id} 填写了不存在的字段 ${field}`)
    }
    if (step.kind === 'assert-record' || step.kind === 'assert-record-absent') {
      invariant(fields.has(step.field), `验收场景 ${scenario.id} 断言了不存在的字段 ${step.field}`)
    }
  }
}

/** 校验需求是否已达到可以进入规划阶段的最低完整性。 */
export function validateRequirementContract(contract: BusinessAppRequirementContract): void {
  invariant(contract.schemaVersion === 1, '需求契约版本不支持')
  invariant(contract.goal.trim().length > 0, '需求契约缺少目标')
  uniqueIds(contract.capabilities, '需求能力')
  uniqueIds(contract.acceptanceCriteria, '验收标准')
  uniqueIds(contract.blockingUnknowns, '阻断问题')
  invariant(
    contract.status === (contract.blockingUnknowns.length === 0 ? 'ready' : 'clarifying'),
    '需求契约状态与阻断问题不一致'
  )
  if (contract.status === 'ready') {
    invariant(contract.capabilities.some(item => item.priority === 'must'), '可生成需求至少需要一个必需能力')
    invariant(contract.acceptanceCriteria.length > 0, '可生成需求必须包含验收标准')
    invariant(contract.dataMode !== null, '可生成需求必须确认数据模式')
  }
}

/** 校验完整应用蓝图的拓扑、数据、安全和需求追踪关系。 */
export function validateBusinessApplicationBlueprint(blueprint: BusinessApplicationBlueprint): void {
  invariant(blueprint.schemaVersion === 3, '业务应用蓝图版本不支持')
  invariant(blueprint.app.name.trim().length > 0, '业务应用缺少名称')
  invariant(blueprint.modules.length > 0, '业务应用至少需要一个模块')
  uniqueIds(blueprint.modules, '业务模块')
  uniqueIds(blueprint.entities, '业务实体')
  uniqueIds(blueprint.workflows, '业务工作流')
  uniqueIds(blueprint.dataContracts, '数据契约')
  uniqueIds(blueprint.permissions, '权限')
  uniqueIds(blueprint.acceptanceScenarios, '验收场景')

  const moduleIds = new Set(blueprint.modules.map(module => module.id))
  const entityIds = new Set(blueprint.entities.map(entity => entity.id))
  const workflowIds = new Set(blueprint.workflows.map(workflow => workflow.id))
  const permissionIds = new Set(blueprint.permissions.map(permission => permission.id))
  const requirementIds = new Set(Object.keys(blueprint.requirementCoverage))
  invariant(moduleIds.has(blueprint.shell.homeModuleId), '应用首页模块不存在')
  invariant(blueprint.shell.density === 'compact' || blueprint.shell.density === 'comfortable', '应用壳密度不合法')

  for (const entity of blueprint.entities) validateEntity(entity)
  for (const dataContract of blueprint.dataContracts) {
    invariant(entityIds.has(dataContract.entityId), `数据契约 ${dataContract.id} 使用了不存在的实体`)
    if (dataContract.mode === 'connected') {
      invariant(Boolean(dataContract.connectorId?.trim()), `真实连接数据契约 ${dataContract.id} 必须声明连接器`)
    }
  }
  for (const workflow of blueprint.workflows) {
    invariant(entityIds.has(workflow.entityId), `工作流 ${workflow.id} 使用了不存在的实体`)
    invariant(workflow.states.includes(workflow.initialState), `工作流 ${workflow.id} 的初始状态不存在`)
    for (const transition of workflow.transitions) {
      invariant(workflow.states.includes(transition.to), `工作流 ${workflow.id} 的目标状态不存在`)
      invariant(transition.from.every(state => workflow.states.includes(state)), `工作流 ${workflow.id} 的来源状态不存在`)
      if (transition.risk === 'high') invariant(transition.requiresConfirmation, `高风险流转 ${transition.id} 必须确认`)
    }
  }
  for (const module of blueprint.modules) validateModule(module, entityIds, workflowIds, permissionIds)
  for (const scenario of blueprint.acceptanceScenarios) validateScenario(scenario, blueprint.modules, blueprint.entities, requirementIds)
  for (const [requirementId, targets] of Object.entries(blueprint.requirementCoverage)) {
    invariant(targets.length > 0, `需求 ${requirementId} 没有映射到实现`)
  }
}

/** 校验增量变更计划没有引用蓝图外模块或遗漏需求覆盖。 */
export function validateBusinessAppChangePlan(
  plan: BusinessAppChangePlan,
  blueprint: BusinessApplicationBlueprint
): void {
  invariant(plan.schemaVersion === 1, '变更计划版本不支持')
  invariant(plan.operations.length > 0, '变更计划没有操作')
  const moduleIds = new Set(blueprint.modules.map(module => module.id))
  for (const moduleId of plan.impactedModules) {
    invariant(moduleIds.has(moduleId), `变更计划指向不存在的模块：${moduleId}`)
  }
  for (const requirementId of plan.requirementIds) {
    invariant(requirementId in blueprint.requirementCoverage, `变更计划遗漏需求覆盖：${requirementId}`)
  }
}
