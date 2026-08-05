/**
 * Schema 驱动的业务应用渲染器。
 *
 * 蓝图只承载业务语义；这里输出固定、可审计的多文件运行时。App.vue 仅负责根 Provider，应用壳、
 * 视图组件和状态控制器分别生成，避免单文件组件随模块演进持续膨胀。
 */
import type { BusinessApplicationBlueprint } from '../domain/model'

/** 将蓝图安全序列化为可嵌入 TypeScript 的 JSON，阻止标签和实体字符逃逸。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/** 生成只读蓝图模块，供运行时和构建完整性校验共同使用。 */
export function renderBlueprintSource(blueprint: BusinessApplicationBlueprint): string {
  return `// 本文件由已校验的业务应用蓝图生成，请勿绕过蓝图直接修改。\nexport default ${safeJson(blueprint)} as const\n`
}

/** 生成业务应用使用的最小运行时类型，隔离领域蓝图与 Vue/IDux 组件实现。 */
function renderRuntimeTypes(): string {
  return `/** 生成运行时只消费已校验蓝图，不在组件内重新推断业务语义。 */
export type RuntimeScalar = string | number | boolean
export type RuntimeRecord = Record<string, RuntimeScalar> & { key: string }

export interface RuntimeField {
  key: string
  label: string
  type: string
  required: boolean
  options?: readonly string[]
  placeholder?: string
  helper?: string
}

export interface RuntimeAction {
  id: string
  label: string
  kind: string
  targetViewId?: string
  transitionId?: string
  risk: string
  requiresConfirmation: boolean
  scope: 'global' | 'contextual' | 'bulk'
  expectedResult: string
}

export interface RuntimeViewExperience {
  pattern: string
  density: 'compact' | 'comfortable' | 'spacious'
  contentWidth: 'full' | 'contained'
  responsivePriority: readonly string[]
  states: readonly string[]
  collection?: {
    selection: 'none' | 'single' | 'multiple'
    filtering: 'none' | 'text' | 'property'
    pagination: 'none' | 'pages' | 'progressive'
    contextualDetail: boolean
  }
}

export interface RuntimeSummary {
  id: string
  label: string
  value: string
  helper: string
  tone: string
}

export interface RuntimeSection {
  id: string
  title: string
  description: string
  content: readonly string[]
}

export interface RuntimeView {
  id: string
  name: string
  title: string
  description: string
  kind: 'overview' | 'list' | 'form' | 'detail' | 'custom'
  experience: RuntimeViewExperience
  entityId?: string
  columns: readonly string[]
  fields: readonly string[]
  summaries: readonly RuntimeSummary[]
  sections: readonly RuntimeSection[]
  primaryActions: readonly RuntimeAction[]
  rowActions: readonly RuntimeAction[]
}

export interface RuntimeModule {
  id: string
  name: string
  description: string
  icon: string
  navigationOrder: number
  defaultViewId: string
  workflowIds: readonly string[]
  views: readonly RuntimeView[]
}

export interface RuntimeEntity {
  id: string
  name: string
  idField: string
  fields: readonly RuntimeField[]
  records: readonly Record<string, RuntimeScalar>[]
}

export interface RuntimeWorkflow {
  id: string
  stateField: string
  transitions: readonly { id: string; to: string }[]
}

export interface RuntimeBlueprint {
  app: { name: string; description: string; theme: 'light' | 'dark' }
  shell: { navigation: 'side' | 'top'; homeModuleId: string; density: 'compact' | 'comfortable' }
  modules: readonly RuntimeModule[]
  entities: readonly RuntimeEntity[]
  workflows: readonly RuntimeWorkflow[]
  dataContracts: readonly { mode: 'mock' | 'contract' | 'connected' }[]
}

export interface PendingRuntimeAction {
  action: RuntimeAction
  record: RuntimeRecord | null
}
`
}

/** 生成集中维护隔离演示状态与动作语义的组合式控制器。 */
function renderRuntimeController(): string {
  return `import { computed, reactive, ref } from 'vue'
import type { TableColumn } from '@idux/components/table'
import type { MenuData } from '@idux/components/menu'
import type { ProLayoutType } from '@idux/pro/layout'
import type {
  PendingRuntimeAction,
  RuntimeAction,
  RuntimeBlueprint,
  RuntimeField,
  RuntimeRecord
} from '../app/runtime-types'

/**
 * 解释已校验蓝图并维护预览内状态。
 *
 * 组件只负责呈现和派发动作；导航、表单、记录变更与高风险确认统一留在控制器中。
 */
export function useBusinessAppRuntime(blueprint: RuntimeBlueprint) {
  const orderedModules = [...blueprint.modules].sort((a, b) => a.navigationOrder - b.navigationOrder)
  const activeModuleId = ref(blueprint.shell.homeModuleId)
  const activeViewId = ref('')
  const selectedRecordId = ref<string | null>(null)
  const formMode = ref<'create' | 'edit'>('create')
  const keyword = ref('')
  const pageIndex = ref(1)
  const pageSize = ref(10)
  const refreshing = ref(false)
  const feedback = ref('')
  const formError = ref('')
  const formValues = reactive<Record<string, string | number | boolean>>({})
  const pendingAction = ref<PendingRuntimeAction | null>(null)
  const recordStore = reactive<Record<string, RuntimeRecord[]>>(
    Object.fromEntries(blueprint.entities.map(entity => [
      entity.id,
      entity.records.map((record, index) => ({
        key: String(record[entity.idField] ?? \`demo-\${index + 1}\`),
        ...record
      }))
    ]))
  )

  const activeModule = computed(() =>
    orderedModules.find(module => module.id === activeModuleId.value) ?? orderedModules[0]!
  )
  const activeView = computed(() => {
    const viewId = activeViewId.value || activeModule.value.defaultViewId
    return activeModule.value.views.find(view => view.id === viewId) ?? activeModule.value.views[0]!
  })
  const activeEntity = computed(() =>
    blueprint.entities.find(entity => entity.id === activeView.value.entityId) ?? blueprint.entities[0]!
  )
  const records = computed(() => recordStore[activeEntity.value.id] ?? [])
  const filteredRecords = computed(() => {
    const search = keyword.value.trim().toLowerCase()
    if (!search) return records.value
    return records.value.filter(record =>
      Object.values(record).some(value => String(value).toLowerCase().includes(search))
    )
  })
  const pagedRecords = computed(() => {
    const start = (pageIndex.value - 1) * pageSize.value
    return filteredRecords.value.slice(start, start + pageSize.value)
  })
  const selectedRecord = computed(() => {
    const idField = activeEntity.value.idField
    return records.value.find(record => String(record[idField]) === selectedRecordId.value) ?? null
  })
  const activeFieldMap = computed(() =>
    new Map<string, RuntimeField>(activeEntity.value.fields.map(field => [field.key, field]))
  )
  const formFields = computed(() =>
    activeView.value.fields.map(key => activeFieldMap.value.get(key)).filter(Boolean) as RuntimeField[]
  )
  const detailFields = computed(() =>
    activeView.value.fields.map(key => activeFieldMap.value.get(key)).filter(Boolean) as RuntimeField[]
  )
  const tableColumns = computed<TableColumn<RuntimeRecord>[]>(() => {
    const columns: TableColumn<RuntimeRecord>[] = activeView.value.columns.map((key, index) => {
      const field = activeFieldMap.value.get(key)
      return {
        title: field?.label ?? key,
        dataKey: key,
        width: field?.type === 'datetime' ? 180 : field?.type === 'status' ? 112 : index === 0 ? 184 : 144,
        ...(field?.type === 'status' ? { customCell: 'status' } : {})
      }
    })
    if (activeView.value.rowActions.length > 0) {
      columns.push({ title: '操作', dataKey: 'action', width: Math.max(160, activeView.value.rowActions.length * 60), customCell: 'action' })
    }
    return columns
  })
  const tableScrollWidth = computed(() =>
    Math.max(960, tableColumns.value.reduce((sum, column) => sum + Number(column.width || 144), 0))
  )
  const dataModeLabel = computed(() => {
    const modes = new Set(blueprint.dataContracts.map(item => item.mode))
    if (modes.has('connected')) return '真实连接契约 · 预览隔离数据'
    if (modes.has('contract')) return '接口契约 · 预览演示数据'
    return '安全演示数据'
  })
  const menuItems = computed<MenuData[]>(() => orderedModules.map(module => ({
    type: 'item', key: module.id, label: module.name, icon: module.icon || 'appstore'
  })))
  const layoutType = computed<ProLayoutType>(() => blueprint.shell.navigation === 'top' ? 'header' : 'mixin')

  /** 切换业务模块，并清理上一模块的临时界面状态。 */
  function activateModule(moduleId: string | number): void {
    const module = orderedModules.find(item => item.id === String(moduleId))
    if (!module) return
    activeModuleId.value = module.id
    activeViewId.value = module.defaultViewId
    selectedRecordId.value = null
    keyword.value = ''
    pageIndex.value = 1
    feedback.value = ''
    formError.value = ''
  }

  /** 更新集合筛选并回到第一页，避免页码指向筛选后的空区间。 */
  function updateKeyword(value: string): void {
    keyword.value = value
    pageIndex.value = 1
  }

  /** 模拟隔离数据刷新并保留当前任务上下文。 */
  function refreshCollection(): void {
    refreshing.value = true
    feedback.value = ''
    window.setTimeout(() => {
      refreshing.value = false
      feedback.value = \`已刷新\${activeEntity.value.name}列表\`
    }, 180)
  }

  function updatePagination(nextPageIndex: number, nextPageSize: number): void {
    pageIndex.value = nextPageIndex
    pageSize.value = nextPageSize
  }

  /** 在当前应用内导航到真实业务视图。 */
  function navigate(viewId: string): void {
    const module = orderedModules.find(item => item.views.some(view => view.id === viewId))
    if (!module) return
    activeModuleId.value = module.id
    activeViewId.value = viewId
    formError.value = ''
  }

  function resetForm(): void {
    for (const key of Object.keys(formValues)) delete formValues[key]
  }

  function prepareCreate(): void {
    formMode.value = 'create'
    selectedRecordId.value = null
    resetForm()
  }

  function prepareEdit(record: RuntimeRecord): void {
    formMode.value = 'edit'
    selectedRecordId.value = String(record[activeEntity.value.idField])
    resetForm()
    for (const field of activeEntity.value.fields) {
      if (record[field.key] !== undefined) formValues[field.key] = record[field.key]
    }
  }

  /** 根据动作契约执行导航、提交或进入显式二次确认。 */
  function handleAction(action: RuntimeAction, record: RuntimeRecord | null = null): void {
    feedback.value = ''
    formError.value = ''
    if (action.kind === 'submit') return submitForm(action)
    if (action.kind === 'cancel') {
      if (action.targetViewId) navigate(action.targetViewId)
      return
    }
    if (action.kind === 'create') prepareCreate()
    if (action.kind === 'edit' && record) prepareEdit(record)
    if (record) selectedRecordId.value = String(record[activeEntity.value.idField])
    if (action.requiresConfirmation) {
      pendingAction.value = { action, record }
      return
    }
    if (action.targetViewId) navigate(action.targetViewId)
    else feedback.value = \`已完成\${action.label}（安全演示）\`
  }

  /** 校验并提交创建或编辑表单，结果必须能由列表状态验证。 */
  function submitForm(action: RuntimeAction): void {
    const missing = formFields.value.filter(field =>
      field.required && String(formValues[field.key] ?? '').trim().length === 0
    )
    if (missing.length > 0) {
      formError.value = \`请填写：\${missing.map(field => field.label).join('、')}\`
      return
    }
    const entity = activeEntity.value
    const target = recordStore[entity.id] ?? (recordStore[entity.id] = [])
    if (formMode.value === 'edit' && selectedRecord.value) {
      Object.assign(selectedRecord.value, formValues)
      feedback.value = \`已保存\${entity.name}修改\`
    } else {
      const generatedId = \`\${entity.id}-demo-\${Date.now().toString(36)}\`
      const record: RuntimeRecord = { key: generatedId }
      for (const field of entity.fields) {
        if (formValues[field.key] !== undefined) record[field.key] = formValues[field.key]
        else if (field.key === entity.idField) record[field.key] = generatedId
        else if (field.type === 'datetime') record[field.key] = '2026-08-03 12:00:00'
        else if (field.type === 'status') record[field.key] = field.options?.[0] ?? '已创建'
        else record[field.key] = ''
      }
      target.unshift(record)
      selectedRecordId.value = String(record[entity.idField])
      feedback.value = \`已创建\${entity.name}\`
    }
    resetForm()
    if (action.targetViewId) navigate(action.targetViewId)
  }

  /** 仅在模态确认后执行删除或状态流转。 */
  function confirmPendingAction(): void {
    const pending = pendingAction.value
    if (!pending) return
    const { action } = pending
    const record = pending.record ?? selectedRecord.value
    if (action.kind === 'delete' && record) {
      const target = recordStore[activeEntity.value.id]
      const index = target.indexOf(record)
      if (index >= 0) target.splice(index, 1)
      feedback.value = \`已删除\${activeEntity.value.name}（安全演示）\`
    } else if (action.kind === 'transition' && record) {
      const workflow = blueprint.workflows.find(item => item.id === activeModule.value.workflowIds[0])
      const transition = workflow?.transitions.find(item => item.id === action.transitionId)
      if (workflow && transition) record[workflow.stateField] = transition.to
      feedback.value = \`已完成\${action.label}（安全演示）\`
    } else {
      feedback.value = \`已完成\${action.label}（安全演示）\`
    }
    pendingAction.value = null
  }

  function selectOptions(field: RuntimeField): Array<{ key: string; label: string }> {
    if (field.type === 'boolean') return [{ key: 'true', label: '是' }, { key: 'false', label: '否' }]
    return (field.options ?? []).map(value => ({ key: value, label: value }))
  }

  function statusTone(value: string): 'success' | 'warning' | 'error' | 'normal' {
    if (/运行|启用|完成|充足|正常|成功/.test(value)) return 'success'
    if (/停止|紧张|待|处理中|创建中/.test(value)) return 'warning'
    if (/异常|失败|停用|用尽|删除/.test(value)) return 'error'
    return 'normal'
  }

  return {
    activeModuleId, activeModule, activeView, activeEntity, pagedRecords, selectedRecord,
    formFields, detailFields, tableColumns, tableScrollWidth, dataModeLabel, menuItems, layoutType,
    keyword, pageIndex, pageSize, refreshing, filteredRecordCount: computed(() => filteredRecords.value.length),
    feedback, formError, formValues, pendingAction, activateModule, navigate, updateKeyword,
    refreshCollection, updatePagination, handleAction, confirmPendingAction, selectOptions, statusTone
  }
}
`
}

/** 生成仅负责 Provider 和根应用壳装配的 App.vue。 */
function renderApp(): string {
  return `<template>
  <IxThemeProvider :presetTheme="blueprint.app.theme === 'dark' ? 'dark' : 'default'">
    <BusinessAppShell :blueprint="blueprint" />
  </IxThemeProvider>
</template>

<script setup lang="ts">
import { IxThemeProvider } from '@idux/components/theme'
import blueprintSource from './app/blueprint'
import type { RuntimeBlueprint } from './app/runtime-types'
import BusinessAppShell from './components/shell/BusinessAppShell.vue'

const blueprint = blueprintSource as unknown as RuntimeBlueprint
</script>
`
}

function renderViewHeading(): string {
  return `<template>
  <div class="view-context">
    <IxBreadcrumb>
      <IxBreadcrumbItem>{{ moduleName }}</IxBreadcrumbItem>
      <IxBreadcrumbItem>{{ view.name }}</IxBreadcrumbItem>
    </IxBreadcrumb>
    <header class="view-heading">
      <div class="view-heading-copy">
        <h1>{{ view.title }}</h1>
        <p>{{ view.description }}</p>
      </div>
      <div class="heading-actions">
        <IxButton
          v-for="action in view.primaryActions"
          :key="action.id"
          :data-testid="\`action-\${action.id}\`"
          :mode="action.kind === 'cancel' ? 'default' : 'primary'"
          @click="$emit('action', action)"
        >{{ action.label }}</IxButton>
      </div>
    </header>
  </div>
</template>

<script setup lang="ts">
import { IxBreadcrumb, IxBreadcrumbItem } from '@idux/components/breadcrumb'
import { IxButton } from '@idux/components/button'
import type { RuntimeAction, RuntimeView } from '../../app/runtime-types'

defineProps<{ moduleName: string; view: RuntimeView }>()
defineEmits<{ action: [action: RuntimeAction] }>()
</script>
`
}

function renderActionConfirmModal(): string {
  return `<template>
  <IxModal
    :visible="Boolean(pending)"
    centered
    :closable="false"
    :maskClosable="false"
    type="confirm"
    :title="pending ? \`确认\${pending.action.label}\` : '确认操作'"
    data-testid="confirmation-dialog"
    @close="$emit('cancel')"
  >
    <p class="confirmation-copy">
      将对{{ recordLabel ? \`“\${recordLabel}”\` : '当前对象' }}执行“{{ pending?.action.label }}”。
      该操作会改变当前演示数据，请核对对象与影响后再继续。
    </p>
    <p class="confirmation-note">预览环境不会连接或修改真实业务系统。</p>
    <template #footer>
      <IxButton data-testid="cancel-confirmation" @click="$emit('cancel')">取消</IxButton>
      <IxButton data-testid="confirm-action" mode="primary" danger @click="$emit('confirm')">确认执行</IxButton>
    </template>
  </IxModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IxButton } from '@idux/components/button'
import { IxModal } from '@idux/components/modal'
import type { PendingRuntimeAction } from '../../app/runtime-types'

const props = defineProps<{ pending: PendingRuntimeAction | null }>()
defineEmits<{ cancel: []; confirm: [] }>()

const recordLabel = computed(() => {
  if (!props.pending?.record) return ''
  const values = Object.entries(props.pending.record)
    .filter(([key, value]) => key !== 'key' && String(value).trim().length > 0)
    .slice(0, 2)
    .map(([, value]) => String(value))
  return values.join(' · ')
})
</script>
`
}

function renderOverviewView(): string {
  return `<template>
  <section class="overview-view" :data-pattern="view.experience.pattern" :data-density="view.experience.density">
    <div v-if="view.summaries.length" class="summary-grid">
      <IxCard v-for="summary in view.summaries" :key="summary.id" class="summary-card">
        <span>{{ summary.label }}</span>
        <strong :class="summary.tone">{{ summary.value }}</strong>
        <small>{{ summary.helper }}</small>
      </IxCard>
    </div>
    <IxCard v-for="section in view.sections" :key="section.id" class="content-section">
      <h2>{{ section.title }}</h2>
      <p>{{ section.description }}</p>
      <ul><li v-for="item in section.content" :key="item">{{ item }}</li></ul>
    </IxCard>
  </section>
</template>

<script setup lang="ts">
import { IxCard } from '@idux/components/card'
import type { RuntimeView } from '../../app/runtime-types'
defineProps<{ view: RuntimeView }>()
</script>
`
}

function renderListView(): string {
  return `<template>
  <section
    class="list-view"
    :data-pattern="view.experience.pattern"
    :data-density="view.experience.density"
    :data-states="view.experience.states.join(',')"
  >
    <div v-if="view.summaries.length" class="summary-grid">
      <IxCard v-for="summary in view.summaries" :key="summary.id" class="summary-card">
        <span>{{ summary.label }}</span>
        <strong :class="summary.tone">{{ summary.value }}</strong>
        <small>{{ summary.helper }}</small>
      </IxCard>
    </div>
    <IxCard class="data-card">
      <div class="table-toolbar">
        <div>
          <h2>{{ entity.name }}列表</h2>
          <p>共 {{ total }} 条演示记录</p>
        </div>
        <div class="collection-tools">
          <IxInput
            :value="keyword"
            clearable
            :aria-label="\`搜索\${entity.name}\`"
            :placeholder="\`搜索\${entity.name}关键字段\`"
            data-testid="record-search"
            @update:value="$emit('update:keyword', String($event ?? ''))"
          />
          <IxButton data-testid="refresh-collection" @click="$emit('refresh')">刷新</IxButton>
        </div>
      </div>
      <IxSpin :spinning="refreshing" tip="正在刷新">
        <IxEmpty
          v-if="total === 0"
          :description="keyword ? \`没有符合“\${keyword}”的\${entity.name}\` : \`暂无\${entity.name}\`"
          data-testid="collection-empty"
        />
        <template v-else>
          <IxTable
            :columns="columns"
            :dataSource="records"
            :scroll="{ x: scrollWidth }"
            data-testid="record-table"
          >
            <template #status="{ value }">
              <IxTag :status="statusTone(String(value))" filled>{{ value }}</IxTag>
            </template>
            <template #action="{ record }">
              <div class="row-actions">
                <IxButton
                  v-for="action in view.rowActions"
                  :key="action.id"
                  :data-testid="\`action-\${action.id}\`"
                  mode="link"
                  :danger="action.risk === 'high' || action.kind === 'delete'"
                  @click="$emit('action', action, record)"
                >{{ action.label }}</IxButton>
              </div>
            </template>
          </IxTable>
          <IxPagination
            v-if="view.experience.collection?.pagination === 'pages'"
            class="collection-pagination"
            :pageIndex="pageIndex"
            :pageSize="pageSize"
            :total="total"
            showSizeChanger
            @change="(nextPage, nextSize) => $emit('paginate', nextPage, nextSize)"
          />
        </template>
      </IxSpin>
    </IxCard>
  </section>
</template>

<script setup lang="ts">
import { IxButton } from '@idux/components/button'
import { IxCard } from '@idux/components/card'
import { IxEmpty } from '@idux/components/empty'
import { IxInput } from '@idux/components/input'
import { IxPagination } from '@idux/components/pagination'
import { IxSpin } from '@idux/components/spin'
import { IxTable } from '@idux/components/table'
import type { TableColumn } from '@idux/components/table'
import { IxTag } from '@idux/components/tag'
import type {
  RuntimeAction,
  RuntimeEntity,
  RuntimeRecord,
  RuntimeView
} from '../../app/runtime-types'

defineProps<{
  view: RuntimeView
  entity: RuntimeEntity
  records: RuntimeRecord[]
  columns: TableColumn<RuntimeRecord>[]
  scrollWidth: number
  keyword: string
  total: number
  pageIndex: number
  pageSize: number
  refreshing: boolean
  statusTone: (value: string) => 'success' | 'warning' | 'error' | 'normal'
}>()
defineEmits<{
  action: [action: RuntimeAction, record: RuntimeRecord]
  'update:keyword': [value: string]
  refresh: []
  paginate: [pageIndex: number, pageSize: number]
}>()
</script>
`
}

function renderFormView(): string {
  return `<template>
  <section class="form-view" :data-pattern="experience.pattern" :data-density="experience.density">
    <IxCard class="form-card">
      <IxForm layout="vertical">
        <div class="form-grid">
          <IxFormItem v-for="field in fields" :key="field.key" :label="field.label" :required="field.required">
            <div class="field-control" :data-testid="\`field-\${field.key}\`">
              <IxSelect
                v-if="field.type === 'select' || field.type === 'status' || field.type === 'boolean'"
                v-model:value="values[field.key]"
                :dataSource="selectOptions(field)"
                :getKey="'key'"
                :placeholder="field.placeholder || \`请选择\${field.label}\`"
              />
              <IxTextarea
                v-else-if="field.type === 'textarea'"
                v-model:value="values[field.key]"
                :placeholder="field.placeholder || \`请输入\${field.label}\`"
              />
              <IxInput
                v-else
                v-model:value="values[field.key]"
                :placeholder="field.placeholder || \`请输入\${field.label}\`"
              />
            </div>
            <small v-if="field.helper" class="field-helper">{{ field.helper }}</small>
          </IxFormItem>
        </div>
      </IxForm>
    </IxCard>
  </section>
</template>

<script setup lang="ts">
import { IxCard } from '@idux/components/card'
import { IxForm, IxFormItem } from '@idux/components/form'
import { IxInput } from '@idux/components/input'
import { IxSelect } from '@idux/components/select'
import { IxTextarea } from '@idux/components/textarea'
import type { RuntimeField, RuntimeScalar, RuntimeView } from '../../app/runtime-types'

defineProps<{
  experience: RuntimeView['experience']
  fields: RuntimeField[]
  values: Record<string, RuntimeScalar>
  selectOptions: (field: RuntimeField) => Array<{ key: string; label: string }>
}>()
</script>
`
}

function renderDetailView(): string {
  return `<template>
  <section class="detail-view" :data-pattern="experience.pattern" :data-density="experience.density">
    <IxCard class="detail-card">
      <IxDesc :header="\`\${entity.name}基本信息\`" :col="2">
        <IxDescItem v-for="field in fields" :key="field.key" :label="field.label">
          <IxTag
            v-if="field.type === 'status'"
            :status="statusTone(String(record?.[field.key] ?? ''))"
            filled
          >{{ record?.[field.key] ?? '-' }}</IxTag>
          <span v-else>{{ record?.[field.key] ?? '-' }}</span>
        </IxDescItem>
      </IxDesc>
    </IxCard>
  </section>
</template>

<script setup lang="ts">
import { IxCard } from '@idux/components/card'
import { IxDesc, IxDescItem } from '@idux/components/desc'
import { IxTag } from '@idux/components/tag'
import type { RuntimeEntity, RuntimeField, RuntimeRecord, RuntimeView } from '../../app/runtime-types'

defineProps<{
  experience: RuntimeView['experience']
  entity: RuntimeEntity
  fields: RuntimeField[]
  record: RuntimeRecord | null
  statusTone: (value: string) => 'success' | 'warning' | 'error' | 'normal'
}>()
</script>
`
}

function renderBusinessAppShell(): string {
  return `<template>
  <IxProLayout
    :activeKey="activeModuleId"
    :menus="menuItems"
    :type="layoutType"
    :theme="blueprint.app.theme"
    :data-module-count="blueprint.modules.length"
    class="business-app-shell"
    @update:activeKey="activateModule"
  >
    <template #logo>
      <div class="app-logo" aria-label="应用名称">
        <span class="app-logo-mark">{{ blueprint.app.name.slice(0, 1) }}</span>
        <strong>{{ blueprint.app.name }}</strong>
      </div>
    </template>
    <template #itemLabel="item">
      <span :data-testid="\`module-\${String(item.key)}\`">{{ item.label }}</span>
    </template>
    <template v-if="blueprint.shell.navigation === 'side'" #headerContent>
      <div class="app-header-context">
        <strong>{{ activeModule.name }}</strong>
        <span>{{ activeModule.description }}</span>
      </div>
    </template>
    <template #headerExtra>
      <IxTag status="info" filled>{{ dataModeLabel }}</IxTag>
    </template>
    <template v-if="blueprint.shell.navigation === 'side'" #siderFooter>
      <IxLayoutSiderTrigger />
    </template>

    <main
      class="app-workspace"
      :class="[\`density-\${blueprint.shell.density}\`, \`content-\${activeView.experience.contentWidth}\`]"
      :data-testid="\`view-\${activeView.id}\`"
      :data-enterprise-pattern="activeView.experience.pattern"
    >
      <ViewHeading :moduleName="activeModule.name" :view="activeView" @action="handleAction" />
      <IxAlert
        v-if="feedback"
        class="feedback-alert"
        type="success"
        :title="feedback"
        data-testid="business-feedback"
      />
      <IxAlert
        v-if="formError"
        class="feedback-alert"
        type="error"
        :title="formError"
        data-testid="form-error"
      />

      <OverviewView v-if="activeView.kind === 'overview' || activeView.kind === 'custom'" :view="activeView" />
      <ListView
        v-else-if="activeView.kind === 'list'"
        :view="activeView"
        :entity="activeEntity"
        :records="pagedRecords"
        :columns="tableColumns"
        :scrollWidth="tableScrollWidth"
        :keyword="keyword"
        :total="filteredRecordCount"
        :pageIndex="pageIndex"
        :pageSize="pageSize"
        :refreshing="refreshing"
        :statusTone="statusTone"
        @update:keyword="updateKeyword"
        @refresh="refreshCollection"
        @paginate="updatePagination"
        @action="handleAction"
      />
      <FormView
        v-else-if="activeView.kind === 'form'"
        :experience="activeView.experience"
        :fields="formFields"
        :values="formValues"
        :selectOptions="selectOptions"
      />
      <DetailView
        v-else-if="activeView.kind === 'detail'"
        :experience="activeView.experience"
        :entity="activeEntity"
        :fields="detailFields"
        :record="selectedRecord"
        :statusTone="statusTone"
      />
    </main>

    <ActionConfirmModal
      :pending="pendingAction"
      @cancel="pendingAction = null"
      @confirm="confirmPendingAction"
    />
  </IxProLayout>
</template>

<script setup lang="ts">
import { IxAlert } from '@idux/components/alert'
import { IxLayoutSiderTrigger } from '@idux/components/layout'
import { IxTag } from '@idux/components/tag'
import { IxProLayout } from '@idux/pro/layout'
import type { RuntimeBlueprint } from '../../app/runtime-types'
import { useBusinessAppRuntime } from '../../composables/use-business-app-runtime'
import ActionConfirmModal from '../feedback/ActionConfirmModal.vue'
import DetailView from '../views/DetailView.vue'
import FormView from '../views/FormView.vue'
import ListView from '../views/ListView.vue'
import OverviewView from '../views/OverviewView.vue'
import ViewHeading from './ViewHeading.vue'

const props = defineProps<{ blueprint: RuntimeBlueprint }>()
const {
  activeModuleId, activeModule, activeView, activeEntity, pagedRecords, selectedRecord,
  formFields, detailFields, tableColumns, tableScrollWidth, dataModeLabel, menuItems, layoutType,
  keyword, pageIndex, pageSize, refreshing, filteredRecordCount, feedback, formError, formValues,
  pendingAction, activateModule, updateKeyword, refreshCollection, updatePagination, handleAction,
  confirmPendingAction, selectOptions, statusTone
} = useBusinessAppRuntime(props.blueprint)
</script>

<style src="../../styles/app-shell.css"></style>
`
}

/**
 * 生成固定的多文件 Vue 运行时。
 *
 * 返回值由生成器直接并入产物文件；领域蓝图仍单独写入 blueprint.ts，组件不得改写它。
 */
export function renderBusinessAppRuntimeFiles(): Record<string, string> {
  return {
    'src/App.vue': renderApp(),
    'src/app/runtime-types.ts': renderRuntimeTypes(),
    'src/composables/use-business-app-runtime.ts': renderRuntimeController(),
    'src/components/shell/BusinessAppShell.vue': renderBusinessAppShell(),
    'src/components/shell/ViewHeading.vue': renderViewHeading(),
    'src/components/feedback/ActionConfirmModal.vue': renderActionConfirmModal(),
    'src/components/views/OverviewView.vue': renderOverviewView(),
    'src/components/views/ListView.vue': renderListView(),
    'src/components/views/FormView.vue': renderFormView(),
    'src/components/views/DetailView.vue': renderDetailView()
  }
}
