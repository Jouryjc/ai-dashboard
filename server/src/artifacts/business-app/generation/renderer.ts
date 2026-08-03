/**
 * Schema 驱动的业务应用渲染器。
 *
 * 运行时只解释经过校验的 ApplicationBlueprint，不根据自然语言拼接任意代码，从而让增量开发、
 * 安全检查和端到端验收共享同一份事实来源。
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

/**
 * 生成通用 Vue 业务应用运行时。
 *
 * 模块、视图、字段和操作全部来自蓝图；运行时负责维护预览内隔离状态、高风险确认与可测试标识。
 */
export function renderBusinessAppRuntime(): string {
  return `<template>
  <IxThemeProvider :presetTheme="blueprint.app.theme === 'dark' ? 'dark' : 'default'">
    <main
      class="business-app-shell"
      :class="[\`navigation-\${blueprint.shell.navigation}\`, \`theme-\${blueprint.app.theme}\`]"
      :data-module-count="blueprint.modules.length"
      :data-testid="\`view-\${activeView.id}\`"
    >
      <aside v-if="blueprint.shell.navigation === 'side'" class="app-navigation" aria-label="业务模块导航">
        <div class="app-brand">
          <strong>{{ blueprint.app.name }}</strong>
          <span>{{ blueprint.app.description }}</span>
        </div>
        <nav class="module-navigation">
          <IxButton
            v-for="module in orderedModules"
            :key="module.id"
            :data-testid="\`module-\${module.id}\`"
            :mode="module.id === activeModule.id ? 'primary' : 'text'"
            block
            @click="activateModule(module.id)"
          >{{ module.name }}</IxButton>
        </nav>
        <p class="data-mode-note">{{ dataModeLabel }}</p>
      </aside>

      <section class="app-workspace">
        <header v-if="blueprint.shell.navigation === 'top'" class="top-navigation" aria-label="业务模块导航">
          <div class="app-brand compact">
            <strong>{{ blueprint.app.name }}</strong>
            <span>{{ blueprint.app.description }}</span>
          </div>
          <nav class="top-module-list">
            <IxButton
              v-for="module in orderedModules"
              :key="module.id"
              :data-testid="\`module-\${module.id}\`"
              :mode="module.id === activeModule.id ? 'primary' : 'text'"
              @click="activateModule(module.id)"
            >{{ module.name }}</IxButton>
          </nav>
        </header>

        <div class="breadcrumb-row">
          <span>{{ activeModule.name }}</span>
          <span>/</span>
          <strong>{{ activeView.name }}</strong>
        </div>

        <header class="view-heading">
          <div>
            <h1>{{ activeView.title }}</h1>
            <p>{{ activeView.description }}</p>
          </div>
          <div class="heading-actions">
            <IxButton
              v-for="action in activeView.primaryActions"
              :key="action.id"
              :data-testid="\`action-\${action.id}\`"
              :mode="action.kind === 'cancel' ? 'default' : 'primary'"
              @click="handleAction(action)"
            >{{ action.label }}</IxButton>
          </div>
        </header>

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

        <IxCard v-if="pendingAction" class="confirmation-card" data-testid="confirmation-dialog">
          <h2>确认{{ pendingAction.action.label }}</h2>
          <p>该操作会改变当前演示数据，请确认后继续。预览不会连接或修改真实业务系统。</p>
          <div class="confirmation-actions">
            <IxButton data-testid="confirm-action" mode="primary" danger @click="confirmPendingAction">确认执行</IxButton>
            <IxButton data-testid="cancel-confirmation" @click="pendingAction = null">取消</IxButton>
          </div>
        </IxCard>

        <section v-if="activeView.kind === 'overview'" class="overview-view">
          <div class="summary-grid">
            <IxCard v-for="summary in activeView.summaries" :key="summary.id" class="summary-card">
              <span>{{ summary.label }}</span>
              <strong :class="summary.tone">{{ summary.value }}</strong>
              <small>{{ summary.helper }}</small>
            </IxCard>
          </div>
          <IxCard v-for="section in activeView.sections" :key="section.id" class="content-section">
            <h2>{{ section.title }}</h2>
            <p>{{ section.description }}</p>
            <ul><li v-for="item in section.content" :key="item">{{ item }}</li></ul>
          </IxCard>
        </section>

        <section v-else-if="activeView.kind === 'list'" class="list-view">
          <div v-if="activeView.summaries.length" class="summary-grid">
            <IxCard v-for="summary in activeView.summaries" :key="summary.id" class="summary-card">
              <span>{{ summary.label }}</span>
              <strong :class="summary.tone">{{ summary.value }}</strong>
              <small>{{ summary.helper }}</small>
            </IxCard>
          </div>
          <IxCard class="data-card">
            <div class="table-toolbar">
              <div>
                <h2>{{ activeEntity.name }}列表</h2>
                <p>共 {{ filteredRecords.length }} 条演示记录</p>
              </div>
              <IxInput
                v-model:value="keyword"
                clearable
                :aria-label="\`搜索\${activeEntity.name}\`"
                :placeholder="\`搜索\${activeEntity.name}关键字段\`"
                data-testid="record-search"
              />
            </div>
            <IxTable
              :columns="tableColumns"
              :dataSource="filteredRecords"
              :scroll="{ x: tableScrollWidth }"
              data-testid="record-table"
            >
              <template #status="{ value }">
                <IxTag :status="statusTone(String(value))" filled>{{ value }}</IxTag>
              </template>
              <template #action="{ record }">
                <div class="row-actions">
                  <IxButton
                    v-for="action in activeView.rowActions"
                    :key="action.id"
                    :data-testid="\`action-\${action.id}\`"
                    mode="link"
                    @click="handleAction(action, record)"
                  >{{ action.label }}</IxButton>
                </div>
              </template>
            </IxTable>
          </IxCard>
        </section>

        <section v-else-if="activeView.kind === 'form'" class="form-view">
          <IxCard class="form-card">
            <IxForm layout="vertical">
              <div class="form-grid">
                <IxFormItem v-for="field in formFields" :key="field.key" :label="field.label" :required="field.required">
                  <div class="field-control" :data-testid="\`field-\${field.key}\`">
                  <IxSelect
                    v-if="field.type === 'select' || field.type === 'status' || field.type === 'boolean'"
                    v-model:value="formValues[field.key]"
                    :dataSource="selectOptions(field)"
                    :getKey="'key'"
                    :placeholder="field.placeholder || \`请选择\${field.label}\`"
                  />
                  <IxTextarea
                    v-else-if="field.type === 'textarea'"
                    v-model:value="formValues[field.key]"
                    :placeholder="field.placeholder || \`请输入\${field.label}\`"
                  />
                  <IxInput
                    v-else
                    v-model:value="formValues[field.key]"
                    :placeholder="field.placeholder || \`请输入\${field.label}\`"
                  />
                  </div>
                  <small v-if="field.helper" class="field-helper">{{ field.helper }}</small>
                </IxFormItem>
              </div>
            </IxForm>
          </IxCard>
        </section>

        <section v-else-if="activeView.kind === 'detail'" class="detail-view">
          <IxCard class="detail-card">
            <IxDesc :header="\`\${activeEntity.name}基本信息\`" :col="2">
              <IxDescItem v-for="field in detailFields" :key="field.key" :label="field.label">
                <IxTag v-if="field.type === 'status'" :status="statusTone(String(selectedRecord?.[field.key] ?? ''))" filled>
                  {{ selectedRecord?.[field.key] ?? '-' }}
                </IxTag>
                <span v-else>{{ selectedRecord?.[field.key] ?? '-' }}</span>
              </IxDescItem>
            </IxDesc>
          </IxCard>
        </section>

        <section v-else class="custom-view">
          <IxCard v-for="section in activeView.sections" :key="section.id" class="content-section">
            <h2>{{ section.title }}</h2>
            <p>{{ section.description }}</p>
            <ul><li v-for="item in section.content" :key="item">{{ item }}</li></ul>
          </IxCard>
        </section>
      </section>
    </main>
  </IxThemeProvider>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { IxAlert } from '@idux/components/alert'
import { IxButton } from '@idux/components/button'
import { IxCard } from '@idux/components/card'
import { IxDesc, IxDescItem } from '@idux/components/desc'
import { IxForm, IxFormItem } from '@idux/components/form'
import { IxInput } from '@idux/components/input'
import { IxSelect } from '@idux/components/select'
import { IxTable } from '@idux/components/table'
import type { TableColumn } from '@idux/components/table'
import { IxTag } from '@idux/components/tag'
import { IxTextarea } from '@idux/components/textarea'
import { IxThemeProvider } from '@idux/components/theme'
import blueprintSource from './app/blueprint'

type AnyRecord = Record<string, string | number | boolean> & { key: string }
type AnyField = { key: string; label: string; type: string; required: boolean; options?: readonly string[]; placeholder?: string; helper?: string }
type AnyAction = { id: string; label: string; kind: string; targetViewId?: string; transitionId?: string; risk: string; requiresConfirmation: boolean }

const blueprint: any = blueprintSource
const orderedModules = [...blueprint.modules].sort((a: any, b: any) => a.navigationOrder - b.navigationOrder)
const activeModuleId = ref(blueprint.shell.homeModuleId)
const activeViewId = ref('')
const selectedRecordId = ref<string | null>(null)
const formMode = ref<'create' | 'edit'>('create')
const keyword = ref('')
const feedback = ref('')
const formError = ref('')
const formValues = reactive<Record<string, string | number | boolean>>({})
const pendingAction = ref<{ action: AnyAction; record: AnyRecord | null } | null>(null)
const recordStore = reactive<Record<string, AnyRecord[]>>(
  Object.fromEntries(blueprint.entities.map((entity: any) => [
    entity.id,
    entity.records.map((record: Record<string, string | number | boolean>, index: number) => ({
      key: String(record[entity.idField] ?? \`demo-\${index + 1}\`),
      ...record
    }))
  ]))
)

const activeModule = computed(() =>
  blueprint.modules.find((module: any) => module.id === activeModuleId.value) ?? blueprint.modules[0]
)
const activeView = computed(() => {
  const viewId = activeViewId.value || activeModule.value.defaultViewId
  return activeModule.value.views.find((view: any) => view.id === viewId) ?? activeModule.value.views[0]
})
const activeEntity = computed(() =>
  blueprint.entities.find((entity: any) => entity.id === activeView.value.entityId) ?? blueprint.entities[0]
)
const records = computed(() => recordStore[activeEntity.value.id] ?? [])
const filteredRecords = computed(() => {
  const search = keyword.value.trim().toLowerCase()
  if (!search) return records.value
  return records.value.filter(record => Object.values(record).some(value => String(value).toLowerCase().includes(search)))
})
const selectedRecord = computed(() => {
  const idField = activeEntity.value.idField
  return records.value.find(record => String(record[idField]) === selectedRecordId.value) ?? null
})
const activeFieldMap = computed(() => new Map<string, AnyField>(activeEntity.value.fields.map((field: AnyField) => [field.key, field])))
const formFields = computed(() => activeView.value.fields.map((key: string) => activeFieldMap.value.get(key)).filter(Boolean) as AnyField[])
const detailFields = computed(() => activeView.value.fields.map((key: string) => activeFieldMap.value.get(key)).filter(Boolean) as AnyField[])
const tableColumns = computed<TableColumn<AnyRecord>[]>(() => {
  const columns = activeView.value.columns.map((key: string, index: number) => {
    const field = activeFieldMap.value.get(key)
    return {
      title: field?.label ?? key,
      dataKey: key,
      width: field?.type === 'datetime' ? 180 : field?.type === 'status' ? 120 : index === 0 ? 200 : 160,
      ...(field?.type === 'status' ? { customCell: 'status' } : {})
    }
  })
  if (activeView.value.rowActions.length > 0) {
    columns.push({ title: '操作', dataKey: 'action', width: Math.max(120, activeView.value.rowActions.length * 64), customCell: 'action' })
  }
  return columns
})
const tableScrollWidth = computed(() => Math.max(1120, tableColumns.value.reduce((sum, column) => sum + Number(column.width || 160), 0)))
const dataModeLabel = computed(() => {
  const modes = new Set(blueprint.dataContracts.map((item: any) => item.mode))
  if (modes.has('connected')) return '真实连接契约（预览隔离数据）'
  if (modes.has('contract')) return '接口契约（预览演示数据）'
  return '安全演示数据模式'
})

/** 切换业务模块，并回到该模块的默认视图。 */
function activateModule(moduleId: string): void {
  const module = blueprint.modules.find((item: any) => item.id === moduleId)
  if (!module) return
  activeModuleId.value = moduleId
  activeViewId.value = module.defaultViewId
  selectedRecordId.value = null
  feedback.value = ''
}

/** 在当前模块内导航到指定视图。 */
function navigate(viewId: string): void {
  const module = blueprint.modules.find((item: any) => item.views.some((view: any) => view.id === viewId))
  if (!module) return
  activeModuleId.value = module.id
  activeViewId.value = viewId
  formError.value = ''
}

/** 清空当前表单状态，避免创建与编辑数据互相污染。 */
function resetForm(): void {
  for (const key of Object.keys(formValues)) delete formValues[key]
}

/** 初始化创建表单。 */
function prepareCreate(): void {
  formMode.value = 'create'
  selectedRecordId.value = null
  resetForm()
}

/** 使用所选记录初始化编辑表单。 */
function prepareEdit(record: AnyRecord): void {
  formMode.value = 'edit'
  selectedRecordId.value = String(record[activeEntity.value.idField])
  resetForm()
  for (const field of activeEntity.value.fields as AnyField[]) {
    if (record[field.key] !== undefined) formValues[field.key] = record[field.key]
  }
}

/** 根据蓝图动作语义执行导航、表单或高风险确认流程。 */
function handleAction(action: AnyAction, record: AnyRecord | null = null): void {
  feedback.value = ''
  formError.value = ''
  if (action.kind === 'submit') {
    submitForm(action)
    return
  }
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

/** 在隔离预览状态中提交创建或编辑，并给出明确结果反馈。 */
function submitForm(action: AnyAction): void {
  const missing = formFields.value.filter(field => field.required && String(formValues[field.key] ?? '').trim().length === 0)
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
    const firstField = entity.fields[0]
    const generatedId = \`\${entity.id}-demo-\${Date.now().toString(36)}\`
    const record: AnyRecord = { key: generatedId }
    for (const field of entity.fields as AnyField[]) {
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

/** 确认并执行删除或状态流转等受保护操作。 */
function confirmPendingAction(): void {
  const pending = pendingAction.value
  if (!pending) return
  const action = pending.action
  const record = pending.record ?? selectedRecord.value
  if (action.kind === 'delete' && record) {
    const target = recordStore[activeEntity.value.id]
    const index = target.indexOf(record)
    if (index >= 0) target.splice(index, 1)
    feedback.value = \`已删除\${activeEntity.value.name}（安全演示）\`
  } else if (action.kind === 'transition' && record) {
    const workflow = blueprint.workflows.find((item: any) => item.id === activeModule.value.workflowIds[0])
    const transition = workflow?.transitions.find((item: any) => item.id === action.transitionId)
    if (workflow && transition) record[workflow.stateField] = transition.to
    feedback.value = \`已完成\${action.label}（安全演示）\`
  } else {
    feedback.value = \`已完成\${action.label}（安全演示）\`
  }
  pendingAction.value = null
}

/** 将字段枚举转换为 IDux Select 使用的选项结构。 */
function selectOptions(field: AnyField): Array<{ key: string; label: string }> {
  if (field.type === 'boolean') return [{ key: 'true', label: '是' }, { key: 'false', label: '否' }]
  return (field.options ?? []).map(value => ({ key: value, label: value }))
}

/** 根据业务状态文本计算 IDux 标签语义色。 */
function statusTone(value: string): 'success' | 'warning' | 'error' | 'normal' {
  if (/运行|启用|完成|充足|正常|成功/.test(value)) return 'success'
  if (/停止|紧张|待|处理中|创建中/.test(value)) return 'warning'
  if (/异常|失败|停用|用尽|删除/.test(value)) return 'error'
  return 'normal'
}
</script>

<style src="./styles/app-shell.css"></style>
`
}
