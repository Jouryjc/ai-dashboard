/**
 * 业务应用蓝图规划器。
 *
 * 规划器把已就绪的需求契约转换为完整 ApplicationBlueprint 与增量 ChangePlan。
 * 确定性规划提供安全可执行基线，模型只能在领域校验和变更边界内增强该基线。
 */
import crypto from 'node:crypto'
import * as gw from '../../../gateway'
import { prompt } from '../../../prompts'
import type { ModelSettings } from '../../../wire'
import type {
  BusinessApplicationBlueprint,
  BusinessAppAcceptanceScenario,
  BusinessAppActionDefinition,
  BusinessAppChangePlan,
  BusinessAppEntityDefinition,
  BusinessAppFieldDefinition,
  BusinessAppModuleDefinition,
  BusinessAppPlanResult,
  BusinessAppRequirementContract,
  BusinessAppSummaryDefinition,
  BusinessAppViewExperience,
  BusinessAppViewDefinition,
  BusinessAppWorkflowDefinition
} from '../domain/model'
import {
  validateBusinessApplicationBlueprint,
  validateBusinessAppChangePlan
} from '../domain/validation'
import type { BusinessAppReferenceAnalysis } from '../reference'

/** 规划所需的当前应用、基线版本、模型设置和参考图呈现证据。 */
export interface PlanBusinessApplicationOptions {
  currentBlueprint?: BusinessApplicationBlueprint | null
  baseRevisionId?: string | null
  settings?: ModelSettings
  presentation?: {
    navigation?: 'side' | 'top'
    theme?: 'light' | 'dark'
  }
  presentationEvidence?: BusinessAppReferenceAnalysis | null
  enterpriseGuidance?: string
}

/** 内置领域样例的数据结构；未知领域由通用结构或模型蓝图承接。 */
interface DomainPreset {
  moduleName: string
  entityName: string
  fields: BusinessAppFieldDefinition[]
  records: Array<Record<string, string | number | boolean>>
  summaries: BusinessAppSummaryDefinition[]
  states: string[]
}

/** 将自由文本规整为合法模块 ID。 */
function safeId(value: string): string {
  const direct = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return /^[a-z][a-z0-9-]{0,63}$/.test(direct)
    ? direct
    : `module-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}`
}

/** 从需求目标推断默认模块显示名称。 */
function moduleName(contract: BusinessAppRequirementContract): string {
  const goal = contract.goal
  if (/云主机|云服务器|ecs/i.test(goal)) return '云主机'
  if (/配额/.test(goal)) return '配额'
  if (/用户|账号/.test(goal)) return '用户管理'
  if (/角色|权限/.test(goal)) return '角色权限'
  if (/订单|交易/.test(goal)) return '订单管理'
  if (/审批|审核/.test(goal)) return '审批管理'
  const match = /([\p{Script=Han}A-Za-z0-9_-]{2,16}?)(?:管理)?(?:模块|功能|应用|页面)/u.exec(goal)
  return match?.[1] || '业务记录'
}

/** 创建字段定义，统一处理可选枚举项。 */
function field(
  key: string,
  label: string,
  type: BusinessAppFieldDefinition['type'],
  required = false,
  options?: string[]
): BusinessAppFieldDefinition {
  return { key, label, type, required, ...(options ? { options } : {}) }
}

/**
 * 为常见领域提供安全演示数据基线。
 *
 * 预设不是业务能力上限；未命中领域会走通用实体，模型可在受控蓝图中完整替换目标模块。
 */
function domainPreset(contract: BusinessAppRequirementContract): DomainPreset {
  const goal = contract.goal
  if (/云主机|云服务器|ecs/i.test(goal)) {
    return {
      moduleName: '云主机',
      entityName: '云主机实例',
      fields: [
        field('instanceId', '实例 ID', 'text', true),
        field('name', '实例名称', 'text', true),
        field('status', '状态', 'status', true, ['运行中', '已停止', '创建中', '异常']),
        field('region', '地域', 'select', true, ['华东 1', '华北 2', '华南 1']),
        field('image', '镜像', 'select', true, ['Ubuntu 22.04', 'Rocky Linux 9', 'Debian 12']),
        field('specification', '实例规格', 'select', true, ['2 核 4 GB', '4 核 8 GB', '8 核 16 GB']),
        field('privateIp', '内网 IP', 'text'),
        field('createdAt', '创建时间', 'datetime')
      ],
      records: [
        { instanceId: 'ecs-demo-001', name: 'web-service-01', status: '运行中', region: '华东 1', image: 'Ubuntu 22.04', specification: '4 核 8 GB', privateIp: '192.0.2.10', createdAt: '2026-08-01 09:20:00' },
        { instanceId: 'ecs-demo-002', name: 'api-service-01', status: '已停止', region: '华北 2', image: 'Rocky Linux 9', specification: '8 核 16 GB', privateIp: '192.0.2.11', createdAt: '2026-07-29 14:10:00' },
        { instanceId: 'ecs-demo-003', name: 'batch-worker-01', status: '异常', region: '华南 1', image: 'Debian 12', specification: '2 核 4 GB', privateIp: '192.0.2.12', createdAt: '2026-07-26 11:05:00' }
      ],
      summaries: [
        { id: 'total', label: '实例总数', value: '3 台', helper: '当前演示项目', tone: 'normal' },
        { id: 'running', label: '运行中', value: '1 台', helper: '状态正常', tone: 'success' },
        { id: 'stopped', label: '已停止', value: '1 台', helper: '可重新启动', tone: 'warning' },
        { id: 'abnormal', label: '异常', value: '1 台', helper: '需要处理', tone: 'error' }
      ],
      states: ['创建中', '运行中', '已停止', '异常']
    }
  }
  if (/配额/.test(goal)) {
    return {
      moduleName: '配额管理',
      entityName: '资源配额',
      fields: [
        field('quotaId', '配额 ID', 'text', true),
        field('resource', '资源类型', 'select', true, ['云主机', 'CPU 核数', '内存', '云硬盘']),
        field('used', '已使用', 'number', true),
        field('limit', '配额上限', 'number', true),
        field('remaining', '剩余', 'number'),
        field('status', '状态', 'status', true, ['充足', '紧张', '已用尽']),
        field('updatedAt', '更新时间', 'datetime')
      ],
      records: [
        { quotaId: 'quota-demo-001', resource: '云主机', used: 12, limit: 20, remaining: 8, status: '充足', updatedAt: '2026-08-02 09:00:00' },
        { quotaId: 'quota-demo-002', resource: 'CPU 核数', used: 78, limit: 96, remaining: 18, status: '紧张', updatedAt: '2026-08-02 09:00:00' },
        { quotaId: 'quota-demo-003', resource: '云硬盘', used: 40, limit: 40, remaining: 0, status: '已用尽', updatedAt: '2026-08-02 09:00:00' }
      ],
      summaries: [
        { id: 'items', label: '配额项', value: '3 项', helper: '当前演示项目', tone: 'normal' },
        { id: 'healthy', label: '配额充足', value: '1 项', helper: '无需处理', tone: 'success' },
        { id: 'tight', label: '接近上限', value: '1 项', helper: '建议申请扩容', tone: 'warning' },
        { id: 'exhausted', label: '已用尽', value: '1 项', helper: '阻止继续创建', tone: 'error' }
      ],
      states: ['充足', '紧张', '已用尽']
    }
  }
  if (/用户|账号/.test(goal)) {
    return {
      moduleName: '用户管理',
      entityName: '用户',
      fields: [
        field('userId', '用户 ID', 'text', true),
        field('name', '姓名', 'text', true),
        field('username', '登录名', 'text', true),
        field('role', '角色', 'select', true, ['管理员', '运维人员', '只读用户']),
        field('department', '部门', 'select', true, ['平台研发', '业务运营', '安全管理']),
        field('status', '状态', 'status', true, ['启用', '停用']),
        field('lastLoginAt', '最近登录', 'datetime')
      ],
      records: [
        { userId: 'user-demo-001', name: '演示用户 A', username: 'demo-a', role: '管理员', department: '平台研发', status: '启用', lastLoginAt: '2026-08-02 10:20:00' },
        { userId: 'user-demo-002', name: '演示用户 B', username: 'demo-b', role: '运维人员', department: '业务运营', status: '启用', lastLoginAt: '2026-08-01 16:40:00' },
        { userId: 'user-demo-003', name: '演示用户 C', username: 'demo-c', role: '只读用户', department: '安全管理', status: '停用', lastLoginAt: '2026-07-30 08:15:00' }
      ],
      summaries: [
        { id: 'users', label: '用户总数', value: '3 人', helper: '安全演示账号', tone: 'normal' },
        { id: 'enabled', label: '已启用', value: '2 人', helper: '可以登录', tone: 'success' },
        { id: 'disabled', label: '已停用', value: '1 人', helper: '禁止登录', tone: 'warning' }
      ],
      states: ['启用', '停用']
    }
  }
  const name = moduleName(contract)
  return {
    moduleName: `${name}管理`,
    entityName: name,
    fields: [
      field('recordId', '记录 ID', 'text', true),
      field('name', '名称', 'text', true),
      field('category', '分类', 'select', true, ['默认分类', '重点分类', '其他分类']),
      field('status', '状态', 'status', true, ['待处理', '处理中', '已完成']),
      field('owner', '负责人', 'text'),
      field('updatedAt', '更新时间', 'datetime')
    ],
    records: [
      { recordId: 'record-demo-001', name: '演示记录 A', category: '默认分类', status: '处理中', owner: '演示成员 1', updatedAt: '2026-08-02 09:00:00' },
      { recordId: 'record-demo-002', name: '演示记录 B', category: '重点分类', status: '待处理', owner: '演示成员 2', updatedAt: '2026-08-01 14:30:00' },
      { recordId: 'record-demo-003', name: '演示记录 C', category: '其他分类', status: '已完成', owner: '演示成员 3', updatedAt: '2026-07-31 11:20:00' }
    ],
    summaries: [
      { id: 'total', label: '记录总数', value: '3 条', helper: '安全演示数据', tone: 'normal' },
      { id: 'processing', label: '处理中', value: '1 条', helper: '正在推进', tone: 'warning' },
      { id: 'completed', label: '已完成', value: '1 条', helper: '已形成结果', tone: 'success' }
    ],
    states: ['待处理', '处理中', '已完成']
  }
}

/** 判断需求契约是否包含某类业务能力。 */
function hasCapability(contract: BusinessAppRequirementContract, pattern: RegExp): boolean {
  return contract.capabilities.some(item => pattern.test(`${item.id} ${item.name} ${item.description}`))
}

/** 创建带默认低风险策略的页面操作。 */
function action(
  id: string,
  label: string,
  kind: BusinessAppActionDefinition['kind'],
  extras: Partial<BusinessAppActionDefinition> = {}
): BusinessAppActionDefinition {
  return {
    id,
    label,
    kind,
    risk: 'low',
    requiresConfirmation: false,
    scope: 'global',
    expectedResult: `${label}完成并产生可验证结果`,
    ...extras
  }
}

/** 根据任务语义生成可由渲染器和验收器共同消费的 B 端页面模式契约。 */
function viewExperience(
  kind: BusinessAppViewDefinition['kind'],
  mode: 'list' | 'create' | 'detail' | 'edit' | 'custom',
  primaryFields: string[]
): BusinessAppViewExperience {
  if (mode === 'list') {
    return {
      pattern: 'collection-table',
      density: 'compact',
      contentWidth: 'full',
      responsivePriority: primaryFields.slice(0, 4).concat('status', 'actions'),
      states: ['loading', 'ready', 'empty', 'no-results', 'error', 'permission-denied'],
      collection: {
        selection: 'single',
        filtering: 'text',
        pagination: 'pages',
        contextualDetail: false
      }
    }
  }
  if (mode === 'create') {
    return {
      pattern: primaryFields.length > 15 ? 'create-multi-step' : 'create-single-page',
      density: 'comfortable',
      contentWidth: 'contained',
      responsivePriority: primaryFields.slice(0, 6).concat('validation', 'submit'),
      states: ['ready', 'error', 'permission-denied']
    }
  }
  if (mode === 'edit') {
    return {
      pattern: primaryFields.length <= 3 ? 'edit-inline' : 'edit-full-page',
      density: 'comfortable',
      contentWidth: 'contained',
      responsivePriority: primaryFields.slice(0, 6).concat('validation', 'save'),
      states: ['loading', 'ready', 'error', 'permission-denied']
    }
  }
  if (mode === 'detail') {
    return {
      pattern: 'object-details',
      density: 'comfortable',
      contentWidth: 'contained',
      responsivePriority: primaryFields.slice(0, 6).concat('status', 'actions'),
      states: ['loading', 'ready', 'error', 'permission-denied']
    }
  }
  return {
    pattern: kind === 'overview' ? 'service-dashboard' : 'custom-task',
    density: 'comfortable',
    contentWidth: 'full',
    responsivePriority: ['task', 'status', 'primary-action'],
    states: ['loading', 'ready', 'empty', 'error', 'permission-denied']
  }
}

/** 将历史蓝图补齐为当前企业体验契约，不改变其业务模块、字段、流程和数据语义。 */
function normalizeCurrentBlueprint(
  source: BusinessApplicationBlueprint | null | undefined
): BusinessApplicationBlueprint | null {
  if (!source) return null
  const raw = source as unknown as BusinessApplicationBlueprint & { schemaVersion: number }
  return {
    ...raw,
    schemaVersion: 3,
    shell: {
      ...raw.shell,
      density: raw.shell.density === 'compact' ? 'compact' : 'comfortable'
    },
    modules: raw.modules.map(module => ({
      ...module,
      views: module.views.map(view => ({
        ...view,
        experience: view.experience ?? viewExperience(
          view.kind,
          view.kind === 'list'
            ? 'list'
            : view.kind === 'detail'
              ? 'detail'
              : view.kind === 'form' && /edit|编辑/.test(`${view.id} ${view.name}`)
                ? 'edit'
                : view.kind === 'form'
                  ? 'create'
                  : 'custom',
          view.kind === 'list' ? view.columns : view.fields
        ),
        primaryActions: view.primaryActions.map(actionItem => ({
          ...actionItem,
          scope: actionItem.scope ?? 'global',
          expectedResult: actionItem.expectedResult ?? `${actionItem.label}完成并产生可验证结果`
        })),
        rowActions: view.rowActions.map(actionItem => ({
          ...actionItem,
          scope: actionItem.scope ?? 'contextual',
          expectedResult: actionItem.expectedResult ?? `${actionItem.label}完成并更新当前对象`
        }))
      }))
    }))
  }
}

/**
 * 将一个目标模块展开成实体、视图、工作流和可执行验收场景。
 *
 * 只有需求契约明确要求的能力才生成对应操作；删除和状态流转自动附加确认与权限约束。
 */
function buildModule(
  contract: BusinessAppRequirementContract,
  preset: DomainPreset,
  moduleId: string,
  requirementId: string
): {
  module: BusinessAppModuleDefinition
  entity: BusinessAppEntityDefinition
  workflow: BusinessAppWorkflowDefinition
  scenarios: BusinessAppAcceptanceScenario[]
} {
  const entityId = `${moduleId}-entity`
  const workflowId = `${moduleId}-workflow`
  const listId = `${moduleId}-list`
  const createId = `${moduleId}-create`
  const detailId = `${moduleId}-detail`
  const editId = `${moduleId}-edit`
  const canCreate = hasCapability(contract, /create|创建|新增|新建/)
  const canDetail = hasCapability(contract, /detail|详情|查看|管理/)
  const canEdit = hasCapability(contract, /edit|编辑|修改|维护|管理/)
  const canDelete = hasCapability(contract, /delete|删除|注销/)
  const canTransition = hasCapability(contract, /transition|状态|启停|审批|流转/)
  const formFields = preset.fields
    .filter(item => item.key !== preset.fields[0].key && item.type !== 'datetime')
    .map(item => item.key)
  const views: BusinessAppViewDefinition[] = [
    {
      id: listId,
      name: `${preset.entityName}列表`,
      title: preset.moduleName,
      description: `集中处理${preset.entityName}的查询与日常管理任务。当前使用安全演示数据。`,
      kind: 'list',
      experience: viewExperience('list', 'list', preset.fields.slice(0, 7).map(item => item.key)),
      entityId,
      columns: preset.fields.slice(0, 7).map(item => item.key),
      fields: [],
      summaries: preset.summaries,
      primaryActions: canCreate
        ? [action(`${moduleId}-create-action`, `创建${preset.entityName}`, 'create', { targetViewId: createId })]
        : [],
      rowActions: [
        ...(canDetail ? [action(`${moduleId}-detail-action`, '详情', 'navigate', { targetViewId: detailId, scope: 'contextual' })] : []),
        ...(canEdit ? [action(`${moduleId}-edit-action`, '编辑', 'edit', { targetViewId: editId, scope: 'contextual' })] : []),
        ...(canTransition ? [action(`${moduleId}-transition-action`, '变更状态', 'transition', { transitionId: `${moduleId}-toggle-state`, risk: 'medium', requiresConfirmation: true, requiredPermission: `${moduleId}-operate`, scope: 'contextual' })] : []),
        ...(canDelete ? [action(`${moduleId}-delete-action`, '删除', 'delete', { risk: 'high', requiresConfirmation: true, requiredPermission: `${moduleId}-operate`, scope: 'contextual', expectedResult: `删除所选${preset.entityName}并从集合中移除` })] : [])
      ],
      sections: []
    }
  ]
  if (canCreate) {
    views.push({
      id: createId,
      name: `创建${preset.entityName}`,
      title: `创建${preset.entityName}`,
      description: `填写必要信息并创建新的${preset.entityName}。`,
      kind: 'form',
      experience: viewExperience('form', 'create', formFields),
      entityId,
      columns: [],
      fields: formFields,
      summaries: [],
      primaryActions: [
        action(`${moduleId}-submit-create`, '确认创建', 'submit', { targetViewId: listId }),
        action(`${moduleId}-cancel-create`, '取消', 'cancel', { targetViewId: listId })
      ],
      rowActions: [],
      sections: []
    })
  }
  if (canDetail) {
    views.push({
      id: detailId,
      name: `${preset.entityName}详情`,
      title: `${preset.entityName}详情`,
      description: `查看所选${preset.entityName}的完整演示信息。`,
      kind: 'detail',
      experience: viewExperience('detail', 'detail', preset.fields.map(item => item.key)),
      entityId,
      columns: [],
      fields: preset.fields.map(item => item.key),
      summaries: [],
      primaryActions: [action(`${moduleId}-back-detail`, '返回列表', 'cancel', { targetViewId: listId })],
      rowActions: [],
      sections: []
    })
  }
  if (canEdit) {
    views.push({
      id: editId,
      name: `编辑${preset.entityName}`,
      title: `编辑${preset.entityName}`,
      description: `修改所选${preset.entityName}并保存。`,
      kind: 'form',
      experience: viewExperience('form', 'edit', formFields),
      entityId,
      columns: [],
      fields: formFields,
      summaries: [],
      primaryActions: [
        action(`${moduleId}-submit-edit`, '保存修改', 'submit', { targetViewId: listId }),
        action(`${moduleId}-cancel-edit`, '取消', 'cancel', { targetViewId: listId })
      ],
      rowActions: [],
      sections: []
    })
  }

  const workflow: BusinessAppWorkflowDefinition = {
    id: workflowId,
    name: `${preset.entityName}状态流程`,
    entityId,
    stateField: preset.fields.find(item => item.type === 'status')?.key ?? preset.fields[0].key,
    initialState: preset.states[0],
    states: preset.states,
    transitions: canTransition
      ? [{
          id: `${moduleId}-toggle-state`,
          label: '变更状态',
          from: preset.states,
          to: preset.states[1] ?? preset.states[0],
          risk: 'medium',
          requiresConfirmation: true,
          requiredPermission: `${moduleId}-operate`
        }]
      : []
  }
  const entity: BusinessAppEntityDefinition = {
    id: entityId,
    name: preset.entityName,
    idField: preset.fields[0].key,
    fields: preset.fields,
    records: preset.records
  }
  const module: BusinessAppModuleDefinition = {
    id: moduleId,
    name: preset.moduleName,
    description: `${preset.entityName}相关业务能力`,
    icon: 'appstore',
    navigationOrder: 10,
    defaultViewId: listId,
    views,
    entityIds: [entityId],
    workflowIds: [workflowId],
    requirementIds: [requirementId]
  }

  /** 为自动验收生成与字段类型匹配的安全输入值。 */
  const sampleValue = (fieldDef: BusinessAppFieldDefinition): string | number | boolean => {
    if (fieldDef.type === 'number') return 10
    if (fieldDef.type === 'boolean') return true
    if (fieldDef.options?.length) return fieldDef.options[0]
    return fieldDef.key.toLowerCase().includes('name') ? '自动验收记录' : `demo-${fieldDef.key}`
  }
  const createValues = Object.fromEntries(
    preset.fields
      .filter(item => formFields.includes(item.key))
      .map(item => [item.key, sampleValue(item)])
  )
  const displayField = preset.fields.find(item => /name/i.test(item.key)) ?? preset.fields[1] ?? preset.fields[0]
  const firstDisplayValue = preset.records[0]?.[displayField.key] ?? preset.records[0]?.[preset.fields[0].key] ?? ''
  const scenarios: BusinessAppAcceptanceScenario[] = [{
    id: `${moduleId}-scenario-list`,
    name: `查看${preset.entityName}管理视图`,
    requirementIds: [requirementId],
    moduleId,
    viewportProfiles: ['1920x1080', '1366x768'],
    steps: [
      { kind: 'navigate', viewId: listId },
      { kind: 'assert-view', viewId: listId },
      { kind: 'assert-record', field: displayField.key, value: firstDisplayValue }
    ]
  }]
  if (canCreate) {
    scenarios.push({
      id: `${moduleId}-scenario-create`,
      name: `完成${preset.entityName}创建闭环`,
      requirementIds: [requirementId],
      moduleId,
      viewportProfiles: ['1920x1080', '1366x768'],
      steps: [
        { kind: 'navigate', viewId: listId },
        { kind: 'click-action', actionId: `${moduleId}-create-action` },
        { kind: 'assert-view', viewId: createId },
        { kind: 'fill-form', values: createValues },
        { kind: 'submit-form' },
        { kind: 'assert-view', viewId: listId },
        { kind: 'assert-record', field: displayField.key, value: createValues[displayField.key] ?? firstDisplayValue }
      ]
    })
  }
  if (canDetail) {
    scenarios.push({
      id: `${moduleId}-scenario-detail`,
      name: `查看${preset.entityName}详情并返回`,
      requirementIds: [requirementId],
      moduleId,
      viewportProfiles: ['1920x1080', '1366x768'],
      steps: [
        { kind: 'navigate', viewId: listId },
        { kind: 'select-first-record' },
        { kind: 'click-action', actionId: `${moduleId}-detail-action` },
        { kind: 'assert-view', viewId: detailId },
        { kind: 'click-action', actionId: `${moduleId}-back-detail` },
        { kind: 'assert-view', viewId: listId }
      ]
    })
  }
  if (canEdit) {
    const editedValue = displayField.type === 'number'
      ? 20
      : displayField.options?.find(value => value !== firstDisplayValue) ?? '已更新的演示记录'
    scenarios.push({
      id: `${moduleId}-scenario-edit`,
      name: `编辑${preset.entityName}并保存`,
      requirementIds: [requirementId],
      moduleId,
      viewportProfiles: ['1920x1080', '1366x768'],
      steps: [
        { kind: 'navigate', viewId: listId },
        { kind: 'select-first-record' },
        { kind: 'click-action', actionId: `${moduleId}-edit-action` },
        { kind: 'assert-view', viewId: editId },
        { kind: 'fill-form', values: { [displayField.key]: editedValue } },
        { kind: 'submit-form' },
        { kind: 'assert-record', field: displayField.key, value: editedValue }
      ]
    })
  }
  if (canTransition) {
    scenarios.push({
      id: `${moduleId}-scenario-transition`,
      name: `安全执行${preset.entityName}状态流转`,
      requirementIds: [requirementId],
      moduleId,
      viewportProfiles: ['1920x1080', '1366x768'],
      steps: [
        { kind: 'navigate', viewId: listId },
        { kind: 'select-first-record' },
        { kind: 'click-action', actionId: `${moduleId}-transition-action` },
        { kind: 'confirm-action' },
        { kind: 'assert-feedback', contains: '已完成' }
      ]
    })
  }
  if (canDelete) {
    const idValue = preset.records[0]?.[preset.fields[0].key] ?? ''
    scenarios.push({
      id: `${moduleId}-scenario-delete`,
      name: `确认后删除${preset.entityName}`,
      requirementIds: [requirementId],
      moduleId,
      viewportProfiles: ['1920x1080', '1366x768'],
      steps: [
        { kind: 'navigate', viewId: listId },
        { kind: 'select-first-record' },
        { kind: 'click-action', actionId: `${moduleId}-delete-action` },
        { kind: 'confirm-action' },
        { kind: 'assert-record-absent', field: preset.fields[0].key, value: idValue }
      ]
    })
  }
  return { module, entity, workflow, scenarios }
}

/** 获取本轮统一需求 ID；缺失时根据目标生成稳定后备值。 */
function requirementId(contract: BusinessAppRequirementContract): string {
  return contract.acceptanceCriteria[0]?.requirementId ?? `req-${crypto.createHash('sha256').update(contract.goal).digest('hex').slice(0, 10)}`
}

/**
 * 构建确定性完整蓝图，并以模块为边界合并现有应用。
 *
 * 当前目标模块会被替换，其他模块、实体、场景和需求覆盖保持不变。
 */
function deterministicPlan(
  contract: BusinessAppRequirementContract,
  options: PlanBusinessApplicationOptions
): BusinessAppPlanResult {
  const preset = domainPreset(contract)
  const moduleId = contract.targetModuleIds[0] || safeId(preset.moduleName)
  const reqId = requirementId(contract)
  const built = buildModule(contract, preset, moduleId, reqId)
  const current = normalizeCurrentBlueprint(options.currentBlueprint)
  const previousModules = current?.modules.filter(module => module.id !== moduleId) ?? []
  const replacedModule = current?.modules.find(module => module.id === moduleId)
  const replacedEntityIds = new Set(replacedModule?.entityIds ?? [])
  const replacedWorkflowIds = new Set(replacedModule?.workflowIds ?? [])
  const modules = [...previousModules, built.module]
    .map((module, index) => ({ ...module, navigationOrder: (index + 1) * 10 }))
  const entities = [
    ...(current?.entities.filter(entity => !replacedEntityIds.has(entity.id)) ?? []),
    built.entity
  ]
  const workflows = [
    ...(current?.workflows.filter(workflow => !replacedWorkflowIds.has(workflow.id)) ?? []),
    built.workflow
  ]
  const scenarioPrefix = `${moduleId}-scenario-`
  const acceptanceScenarios = [
    ...(current?.acceptanceScenarios.filter(scenario => !scenario.id.startsWith(scenarioPrefix)) ?? []),
    ...built.scenarios
  ]
  const coverageTargets = [
    `module:${moduleId}`,
    ...built.module.views.map(view => `view:${view.id}`),
    ...built.scenarios.map(scenario => `scenario:${scenario.id}`)
  ]
  const blueprint: BusinessApplicationBlueprint = {
    schemaVersion: 3,
    app: current?.app ?? {
      id: 'generated-business-app',
      name: modules.length > 1 ? '业务管理平台' : `${preset.moduleName}应用`,
      description: '由 Loop Engineer 按已确认需求生成的模块化业务应用',
      theme: options.presentation?.theme ?? 'light'
    },
    shell: {
      navigation: options.presentation?.navigation ?? current?.shell.navigation ?? 'side',
      homeModuleId: current?.shell.homeModuleId && modules.some(module => module.id === current.shell.homeModuleId)
        ? current.shell.homeModuleId
        : moduleId,
      density: current?.shell.density ?? 'comfortable'
    },
    modules,
    entities,
    workflows,
    dataContracts: [
      ...(current?.dataContracts.filter(item => !replacedEntityIds.has(item.entityId)) ?? []),
      {
        id: `${moduleId}-data`,
        entityId: built.entity.id,
        mode: contract.dataMode ?? 'mock',
        operations: ['list', 'get', 'create', 'update', 'delete', 'transition'],
        ...(contract.dataMode === 'connected'
          ? {
              connectorId: /已授权连接器：([a-z][a-z0-9-]{1,63})/i.exec(contract.assumptions.join('\n'))?.[1]
            }
          : {})
      }
    ],
    permissions: [
      ...(current?.permissions.filter(item => !item.id.startsWith(`${moduleId}-`)) ?? []),
      { id: `${moduleId}-view`, name: `查看${preset.entityName}`, description: `允许查看${preset.entityName}` },
      { id: `${moduleId}-operate`, name: `操作${preset.entityName}`, description: `允许修改${preset.entityName}及其状态` }
    ],
    acceptanceScenarios,
    requirementCoverage: {
      ...(current?.requirementCoverage ?? {}),
      [reqId]: coverageTargets
    }
  }
  const changePlan: BusinessAppChangePlan = {
    schemaVersion: 1,
    baseRevisionId: options.baseRevisionId ?? null,
    requirementIds: [reqId],
    operations: [{
      kind: replacedModule ? 'replace-module' : 'add-module',
      targetId: moduleId,
      reason: contract.goal,
      requirementIds: [reqId]
    }],
    impactedModules: [moduleId],
    impactedViews: built.module.views.map(view => view.id),
    regressionScenarioIds: current?.acceptanceScenarios.map(scenario => scenario.id) ?? [],
    requiredIduxComponents: [
      'alert', 'breadcrumb', 'button', 'card', 'desc', 'empty', 'form', 'input', 'layout', 'menu',
      'modal', 'pagination', 'pro-layout', 'select', 'spin', 'table', 'tag', 'textarea'
    ],
    securityImpact: {
      dataModeChanged: current?.dataContracts.some(item => item.mode !== contract.dataMode) ?? false,
      permissionChanged: true,
      destructiveActions: built.module.views.flatMap(view => [...view.primaryActions, ...view.rowActions])
        .filter(item => item.risk === 'high')
        .map(item => item.id)
    }
  }
  validateBusinessApplicationBlueprint(blueprint)
  validateBusinessAppChangePlan(changePlan, blueprint)
  return { blueprint, changePlan }
}

/**
 * 校验并收敛模型规划结果。
 *
 * 拒绝脚本、外部地址、凭据和个人信息，阻止修改非目标模块、改变已确认数据模式或使用
 * 未授权组件；任何异常均回退到确定性计划。
 */
function sanitizeModelPlan(
  raw: unknown,
  fallback: BusinessAppPlanResult,
  contract: BusinessAppRequirementContract,
  current: BusinessApplicationBlueprint | null
): BusinessAppPlanResult {
  if (!raw || typeof raw !== 'object') return fallback
  const value = raw as { blueprint?: unknown; changePlan?: unknown }
  if (!value.blueprint || !value.changePlan) return fallback
  try {
    const result = {
      blueprint: value.blueprint as BusinessApplicationBlueprint,
      changePlan: value.changePlan as BusinessAppChangePlan
    }
    validateBusinessApplicationBlueprint(result.blueprint)
    validateBusinessAppChangePlan(result.changePlan, result.blueprint)
    const serialized = JSON.stringify(result)
    if (
      /(?:<script|javascript:|data:text\/html|https?:\/\/|\b(?:password|passwd|secret|token|api[_-]?key)\b)/i.test(serialized) ||
      /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(serialized) ||
      /\b1[3-9]\d{9}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)
    ) {
      throw new Error('模型蓝图包含不安全内容')
    }
    const targetModules = new Set(contract.targetModuleIds)
    for (const module of current?.modules ?? []) {
      if (targetModules.has(module.id)) continue
      const next = result.blueprint.modules.find(item => item.id === module.id)
      if (!next || JSON.stringify(next) !== JSON.stringify(module)) {
        throw new Error(`模型蓝图改动了非目标模块 ${module.id}`)
      }
    }
    if (result.changePlan.impactedModules.some(id => !targetModules.has(id))) {
      throw new Error('模型变更计划越出了目标模块')
    }
    const requiredRequirementIds = new Set(contract.acceptanceCriteria.map(item => item.requirementId))
    for (const requirementId of requiredRequirementIds) {
      if (!result.blueprint.requirementCoverage[requirementId]?.length) throw new Error(`模型蓝图遗漏需求 ${requirementId}`)
      if (!result.blueprint.acceptanceScenarios.some(scenario => scenario.requirementIds.includes(requirementId))) {
        throw new Error(`模型蓝图没有为需求 ${requirementId} 提供可执行场景`)
      }
    }
    if (result.blueprint.dataContracts.some(item => item.mode !== contract.dataMode)) {
      throw new Error('模型蓝图擅自改变了已确认的数据模式')
    }
    const allowedComponents = new Set(Object.keys({
      alert: true, breadcrumb: true, button: true, card: true, checkbox: true, desc: true,
      drawer: true, dropdown: true, empty: true, form: true, input: true, layout: true,
      menu: true, modal: true, pagination: true, 'pro-layout': true, select: true,
      spin: true, stepper: true, table: true, tabs: true, tag: true, textarea: true, theme: true
    }))
    if (result.changePlan.requiredIduxComponents.some(item => !allowedComponents.has(item))) {
      throw new Error('模型计划使用了未授权组件证据')
    }
    return result
  } catch {
    return fallback
  }
}

/**
 * 生成业务应用规划。
 *
 * 确定性计划始终先行；模型可用时携带需求契约、当前蓝图和脱敏呈现证据进行增强。
 */
export async function planBusinessApplication(
  contract: BusinessAppRequirementContract,
  options: PlanBusinessApplicationOptions = {}
): Promise<BusinessAppPlanResult> {
  const currentBlueprint = normalizeCurrentBlueprint(options.currentBlueprint)
  const normalizedOptions = { ...options, currentBlueprint }
  const fallback = deterministicPlan(contract, normalizedOptions)
  if (!options.settings?.apiBase || !options.settings.model) return fallback
  try {
    const reply = await gw.chatCompletion(options.settings, {
      role: 'planner',
      temperature: 0.1,
      maxTokens: 7000,
      messages: [
        {
          role: 'system',
          content: `${prompt('business-app-blueprint.system')}\n\n以下是当前版本 idux-enterprise-design 的受控规划规范：\n${options.enterpriseGuidance ?? ''}`
        },
        {
          role: 'user',
          content: prompt('business-app-blueprint.user', {
            contract: JSON.stringify(contract, null, 2),
            currentBlueprint: currentBlueprint
              ? JSON.stringify(currentBlueprint, null, 2)
              : 'null',
            presentationEvidence: options.presentationEvidence
              ? JSON.stringify(options.presentationEvidence, null, 2)
              : 'null',
            fallbackShape: JSON.stringify(fallback, null, 2)
          })
        }
      ]
    })
    return sanitizeModelPlan(gw.extractJson(reply), fallback, contract, currentBlueprint)
  } catch {
    return fallback
  }
}
