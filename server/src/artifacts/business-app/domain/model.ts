/**
 * business-app 领域契约。
 *
 * 本文件只描述需求、应用蓝图、变更计划和验收场景的数据结构，不包含生成或运行逻辑。
 * 所有跨阶段传递的数据都应先落到这些可序列化契约中，避免依赖临时 Prompt 上下文。
 */

/** 业务应用的数据交付模式：演示数据、接口契约或已授权真实连接。 */
export type BusinessAppDataMode = 'mock' | 'contract' | 'connected'

/** 本轮需求相对当前应用执行的顶层变更类型。 */
export type BusinessAppChangeOperation =
  | 'create-app'
  | 'add-module'
  | 'change-module'
  | 'add-workflow'
  | 'cross-cutting-change'

/** 业务视图的语义类型，渲染器据此选择对应的 IDux 交互结构。 */
export type BusinessAppViewKind =
  | 'overview'
  | 'list'
  | 'form'
  | 'detail'
  | 'custom'

/** 用户可执行操作的语义类型。 */
export type BusinessAppActionKind =
  | 'navigate'
  | 'create'
  | 'edit'
  | 'delete'
  | 'transition'
  | 'submit'
  | 'cancel'
  | 'custom'

/** 业务字段的受控类型集合。 */
export type BusinessAppFieldType =
  | 'text'
  | 'number'
  | 'status'
  | 'datetime'
  | 'boolean'
  | 'select'
  | 'textarea'

/** 用户对单个澄清问题作出的持久化决策。 */
export interface BusinessAppRequirementDecision {
  id: string
  questionId: string
  question: string
  answer: string
  source: 'option' | 'custom' | 'inferred'
  createdAt: number
}

/** 需求契约中的独立业务能力。 */
export interface BusinessAppRequirementCapability {
  id: string
  name: string
  description: string
  priority: 'must' | 'should' | 'could'
}

/** 可追溯到需求的验收标准。 */
export interface BusinessAppAcceptanceCriterion {
  id: string
  requirementId: string
  description: string
  expectedOutcome: string
}

/** 在开始规划前必须消除的高影响未知项。 */
export interface BusinessAppBlockingUnknown {
  id: string
  topic: string
  reason: string
  impact: 'scope' | 'workflow' | 'data' | 'permission' | 'safety'
  priority: number
}

/** 需求澄清阶段的完整输出，也是后续规划阶段唯一可信的业务输入。 */
export interface BusinessAppRequirementContract {
  schemaVersion: 1
  goal: string
  operation: BusinessAppChangeOperation
  targetModuleIds: string[]
  actors: string[]
  capabilities: BusinessAppRequirementCapability[]
  dataMode: BusinessAppDataMode | null
  permissions: string[]
  constraints: string[]
  assumptions: string[]
  decisions: BusinessAppRequirementDecision[]
  blockingUnknowns: BusinessAppBlockingUnknown[]
  acceptanceCriteria: BusinessAppAcceptanceCriterion[]
  status: 'clarifying' | 'ready'
}

/** 单个澄清问题提供的候选答案及其影响。 */
export interface BusinessAppClarificationOption {
  id: string
  title: string
  consequence: string
  recommended: boolean
  recommendReason: string | null
  riskLevel: 'low' | 'medium' | 'high'
}

/** 单轮澄清契约；每一轮严格只允许包含一个问题。 */
export interface BusinessAppClarificationTurn {
  id: string
  intro: string
  question: string
  topic: string
  options: BusinessAppClarificationOption[]
  allowCustomInput: true
}

/** 实体字段定义。 */
export interface BusinessAppFieldDefinition {
  key: string
  label: string
  type: BusinessAppFieldType
  required: boolean
  options?: string[]
  placeholder?: string
  helper?: string
}

/** 业务实体及其用于隔离预览的演示记录。 */
export interface BusinessAppEntityDefinition {
  id: string
  name: string
  idField: string
  fields: BusinessAppFieldDefinition[]
  records: Array<Record<string, string | number | boolean>>
}

/** 概览指标定义。 */
export interface BusinessAppSummaryDefinition {
  id: string
  label: string
  value: string
  helper: string
  tone: 'normal' | 'success' | 'warning' | 'error'
}

/** 页面操作定义，包含跳转目标、权限和风险控制。 */
export interface BusinessAppActionDefinition {
  id: string
  label: string
  kind: BusinessAppActionKind
  targetViewId?: string
  transitionId?: string
  risk: 'low' | 'medium' | 'high'
  requiresConfirmation: boolean
  requiredPermission?: string
}

/** 一个可导航、可验收的业务视图。 */
export interface BusinessAppViewDefinition {
  id: string
  name: string
  title: string
  description: string
  kind: BusinessAppViewKind
  entityId?: string
  columns: string[]
  fields: string[]
  summaries: BusinessAppSummaryDefinition[]
  primaryActions: BusinessAppActionDefinition[]
  rowActions: BusinessAppActionDefinition[]
  sections: Array<{
    id: string
    title: string
    description: string
    content: string[]
  }>
}

/** 可独立演进的业务模块。 */
export interface BusinessAppModuleDefinition {
  id: string
  name: string
  description: string
  icon: string
  navigationOrder: number
  defaultViewId: string
  views: BusinessAppViewDefinition[]
  entityIds: string[]
  workflowIds: string[]
  requirementIds: string[]
}

/** 工作流中的一条受控状态转换。 */
export interface BusinessAppWorkflowTransition {
  id: string
  label: string
  from: string[]
  to: string
  risk: 'low' | 'medium' | 'high'
  requiresConfirmation: boolean
  requiredPermission?: string
}

/** 实体状态机定义。 */
export interface BusinessAppWorkflowDefinition {
  id: string
  name: string
  entityId: string
  stateField: string
  initialState: string
  states: string[]
  transitions: BusinessAppWorkflowTransition[]
}

/** 实体的数据访问边界；connected 模式必须绑定已授权连接器。 */
export interface BusinessAppDataContract {
  id: string
  entityId: string
  mode: BusinessAppDataMode
  operations: Array<'list' | 'get' | 'create' | 'update' | 'delete' | 'transition'>
  connectorId?: string
}

/** 蓝图引用的权限声明。 */
export interface BusinessAppPermissionDefinition {
  id: string
  name: string
  description: string
}

/** 端到端验收场景支持的原子操作。 */
export type BusinessAppScenarioStep =
  | { kind: 'navigate'; viewId: string }
  | { kind: 'click-action'; actionId: string }
  | { kind: 'fill-form'; values: Record<string, string | number | boolean> }
  | { kind: 'submit-form' }
  | { kind: 'select-first-record' }
  | { kind: 'confirm-action' }
  | { kind: 'assert-view'; viewId: string }
  | { kind: 'assert-record'; field: string; value: string | number | boolean }
  | { kind: 'assert-record-absent'; field: string; value: string | number | boolean }
  | { kind: 'assert-feedback'; contains: string }

/** 可在两个目标视口独立执行的验收场景。 */
export interface BusinessAppAcceptanceScenario {
  id: string
  name: string
  requirementIds: string[]
  moduleId: string
  viewportProfiles: Array<'1920x1080' | '1366x768'>
  steps: BusinessAppScenarioStep[]
}

/** 完整业务应用的可执行蓝图，是生成、验证和增量开发的事实来源。 */
export interface BusinessApplicationBlueprint {
  schemaVersion: 2
  app: {
    id: string
    name: string
    description: string
    theme: 'light' | 'dark'
  }
  shell: {
    navigation: 'side' | 'top'
    homeModuleId: string
  }
  modules: BusinessAppModuleDefinition[]
  entities: BusinessAppEntityDefinition[]
  workflows: BusinessAppWorkflowDefinition[]
  dataContracts: BusinessAppDataContract[]
  permissions: BusinessAppPermissionDefinition[]
  acceptanceScenarios: BusinessAppAcceptanceScenario[]
  requirementCoverage: Record<string, string[]>
}

/** 变更计划中的一个原子变更。 */
export interface BusinessAppChangeOperationDefinition {
  kind:
    | 'add-module'
    | 'replace-module'
    | 'add-view'
    | 'change-view'
    | 'add-workflow'
    | 'change-shell'
  targetId: string
  reason: string
  requirementIds: string[]
}

/** 本轮增量变更范围及其回归、安全影响。 */
export interface BusinessAppChangePlan {
  schemaVersion: 1
  baseRevisionId: string | null
  requirementIds: string[]
  operations: BusinessAppChangeOperationDefinition[]
  impactedModules: string[]
  impactedViews: string[]
  regressionScenarioIds: string[]
  requiredIduxComponents: string[]
  securityImpact: {
    dataModeChanged: boolean
    permissionChanged: boolean
    destructiveActions: string[]
  }
}

/** 规划阶段返回的蓝图与变更计划。 */
export interface BusinessAppPlanResult {
  blueprint: BusinessApplicationBlueprint
  changePlan: BusinessAppChangePlan
}
