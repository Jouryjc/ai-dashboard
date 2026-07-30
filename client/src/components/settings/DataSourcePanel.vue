<script setup lang="ts">
/**
 * 设置中心 · 数据源面板（MCP 数据源管理）。
 * 列表每行一张卡：名称 / 地址 / 认证方式徽标 / 启用开关 / 编辑 / 删除（就地二次确认）。
 * 「添加数据源」展开编辑表单：名称 / 地址 / 认证方式三选一（按选择动态显示令牌或请求头名），
 * 每行带「测试连接」+ 三档大白话反馈条（成功时列出"能查到：xx、xx"）。
 * 数据源：useSettingsStore（列表只读展示，编辑走本地草稿，保存时整列表提交）
 */
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import type { DataSourceProbeResult, McpAuthType, McpDataSource } from '../../types'
import AppIcon from '../common/AppIcon.vue'

const emit = defineEmits<{ saved: [] }>()

const store = useSettingsStore()

onMounted(() => store.loadDataSources())

/* ---------- 认证方式（四选一，大白话解释） ---------- */
const AUTH_OPTIONS: Array<{ value: McpAuthType; label: string; hint: string }> = [
  { value: 'none', label: '不用认证', hint: '这个地址谁都能访问，直接连就行' },
  { value: 'bearer', label: '令牌认证', hint: '对方给了一串令牌，连接时自动带上' },
  { value: 'header', label: '自定义请求头', hint: '对方要求填专门的请求头名和值，比如 X-Api-Key' },
  { value: 'hmac', label: 'AK/SK 签名认证', hint: '对方给了一对 AccessKey/SecretKey，每次请求自动按内容算签名（如大屏数据服务）' }
]
const AUTH_LABEL: Record<McpAuthType, string> = {
  none: '不用认证',
  bearer: '令牌认证',
  header: '自定义请求头',
  hmac: 'AK/SK 签名'
}

/* ---------- 编辑表单（本地草稿，保存才落库） ---------- */
/** 正在编辑的草稿；null = 表单收起 */
const draft = ref<McpDataSource | null>(null)
/** 正在编辑的已有数据源 id；null = 新增 */
const editingId = ref<string | null>(null)
const showToken = ref(false)
const showDetail = ref(false)
/** 当前草稿的测试结果 */
const probeResult = ref<DataSourceProbeResult | null>(null)
/** 就地二次确认删除的数据源 id */
const confirmingDeleteId = ref<string | null>(null)

function makeDraft(): McpDataSource {
  return {
    id: `ds-${Date.now()}`,
    name: '',
    url: '',
    authType: 'none',
    token: '',
    headerName: '',
    accessKey: '',
    secretKey: '',
    enabled: true
  }
}

function resetFormState(): void {
  showToken.value = false
  showDetail.value = false
  probeResult.value = null
}

function startAdd(): void {
  editingId.value = null
  draft.value = makeDraft()
  resetFormState()
}

function startEdit(s: McpDataSource): void {
  editingId.value = s.id
  draft.value = { ...s }
  confirmingDeleteId.value = null
  resetFormState()
}

function cancelEdit(): void {
  draft.value = null
  editingId.value = null
  probeResult.value = null
}

/** 当前草稿是否正在测试连接 */
const draftProbing = computed(() => (draft.value ? (store.probing[draft.value.id] ?? false) : false))

/* ---------- 测试连接反馈（三档大白话） ---------- */
type ProbeTone = 'ok' | 'warn' | 'fail'
const probeTone = computed<ProbeTone | null>(() => {
  const p = probeResult.value
  if (!p) return null
  if (p.ok && p.tools.length > 0) return 'ok'
  if (p.ok) return 'warn'
  return 'fail'
})
const PROBE_STYLE: Record<ProbeTone, { box: string; icon: string; iconCls: string }> = {
  ok: {
    box: 'border border-status-done/40 bg-status-done/10',
    icon: 'check-circle',
    iconCls: 'text-status-done'
  },
  warn: {
    box: 'border border-status-attention/40 bg-status-attention-soft',
    icon: 'warning',
    iconCls: 'text-status-attention'
  },
  fail: {
    box: 'border border-danger/40 bg-danger/10',
    icon: 'error',
    iconCls: 'text-danger'
  }
}

async function onTest(): Promise<void> {
  if (!draft.value) return
  showDetail.value = false
  probeResult.value = await store.probeDataSource(draft.value)
}

/* ---------- 保存 / 删除 / 启停 ---------- */
async function onSave(): Promise<void> {
  if (!draft.value) return
  const d: McpDataSource = { ...draft.value, name: draft.value.name.trim() || '未命名数据源' }
  // 认证方式用不到的字段清空，避免残留误导
  if (d.authType !== 'header') d.headerName = ''
  if (d.authType !== 'bearer' && d.authType !== 'header') d.token = ''
  if (d.authType !== 'hmac') {
    d.accessKey = ''
    d.secretKey = ''
  }
  const list = store.dataSources.map((s) => ({ ...s }))
  const i = list.findIndex((s) => s.id === d.id)
  if (i >= 0) list[i] = d
  else list.push(d)
  await store.saveDataSources(list)
  cancelEdit()
  emit('saved')
}

async function onConfirmDelete(id: string): Promise<void> {
  const list = store.dataSources.filter((s) => s.id !== id).map((s) => ({ ...s }))
  confirmingDeleteId.value = null
  if (editingId.value === id) cancelEdit()
  await store.saveDataSources(list)
  emit('saved')
}

async function onToggleEnabled(s: McpDataSource): Promise<void> {
  const list = store.dataSources.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : { ...x }))
  await store.saveDataSources(list)
}

/* ---------- 状态行 ---------- */
const statusLine = computed(() => {
  const n = store.dataSources.length
  return n > 0 ? `已配 ${n} 个数据源` : '还没有配数据源'
})
</script>

<template>
  <section class="rounded-card border border-line bg-card p-6 shadow-card">
    <h2 class="text-base font-semibold text-ink">数据源</h2>

    <!-- 当前状态行 -->
    <p class="mt-2 flex items-center gap-1.5 text-sm text-ink-secondary">
      {{ statusLine }}
      <span class="text-ink-faint">配好之后，生成大屏时就能直接用这里面的真实数据。</span>
    </p>

    <hr class="my-5 border-line" />

    <!-- 数据源列表 -->
    <div v-if="store.dataSources.length > 0" class="space-y-3">
      <div
        v-for="s in store.dataSources"
        :key="s.id"
        class="rounded-card border border-line bg-panel p-4"
      >
        <div class="flex items-center gap-3">
          <AppIcon name="database" :size="16" class="shrink-0 text-ink-faint" />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium text-ink">
              <span class="truncate">{{ s.name }}</span>
              <span class="shrink-0 rounded-full bg-card px-2 py-0.5 text-xs text-ink-secondary">
                {{ AUTH_LABEL[s.authType] }}
              </span>
              <span v-if="!s.enabled" class="shrink-0 text-xs text-ink-faint">已停用</span>
            </p>
            <p class="mt-0.5 truncate text-xs text-ink-faint">{{ s.url || '还没填地址' }}</p>
          </div>
          <label class="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-ink-secondary">
            <input
              type="checkbox"
              :checked="s.enabled"
              :disabled="store.dataSourcesSaving"
              class="h-3.5 w-3.5 accent-primary"
              @change="onToggleEnabled(s)"
            />
            取数时用它
          </label>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-card hover:text-ink"
            @click="startEdit(s)"
          >
            <AppIcon name="edit" :size="14" />
            编辑
          </button>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-1.5 text-sm text-danger hover:bg-card"
            @click="confirmingDeleteId = confirmingDeleteId === s.id ? null : s.id"
          >
            <AppIcon name="delete" :size="14" />
            删除
          </button>
        </div>

        <!-- 删除就地二次确认 -->
        <div
          v-if="confirmingDeleteId === s.id"
          class="mt-3 flex items-center gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink"
        >
          <AppIcon name="warning" :size="14" class="shrink-0 text-danger" />
          <span class="min-w-0 flex-1">删了之后，生成大屏就查不到这份数据了。确定删除？</span>
          <button
            type="button"
            :disabled="store.dataSourcesSaving"
            class="shrink-0 rounded-control bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="onConfirmDelete(s.id)"
          >
            确定删除
          </button>
          <button
            type="button"
            class="shrink-0 rounded-control border border-line px-3 py-1 text-xs text-ink-secondary hover:bg-card"
            @click="confirmingDeleteId = null"
          >
            先留着
          </button>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <p v-else class="rounded-card border border-dashed border-line bg-panel p-4 text-sm text-ink-faint">
      还没有数据源。点下面的「添加数据源」，把公司的数据库接进来。
    </p>

    <!-- 添加数据源 -->
    <div class="mt-4">
      <button
        v-if="!draft"
        type="button"
        class="flex items-center gap-1 rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover active:bg-primary-active"
        @click="startAdd"
      >
        <AppIcon name="add" :size="14" />
        添加数据源
      </button>
    </div>

    <!-- 编辑表单（新增 / 编辑共用，本地草稿，保存才生效） -->
    <div v-if="draft" class="mt-4 rounded-card border border-line bg-panel p-4">
      <h3 class="text-sm font-medium text-ink">
        {{ editingId ? `编辑「${store.dataSources.find((s) => s.id === editingId)?.name ?? ''}」` : '添加数据源' }}
      </h3>

      <div class="mt-4 grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-4">
        <label class="text-sm text-ink-secondary">名称</label>
        <input
          v-model="draft.name"
          type="text"
          placeholder="例如：生产数据库"
          class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
        />

        <label class="text-sm text-ink-secondary">地址</label>
        <input
          v-model="draft.url"
          type="text"
          placeholder="例如 https://data.example.com/mcp"
          class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
        />

        <label class="text-sm text-ink-secondary">认证方式</label>
        <div class="space-y-2">
          <label
            v-for="opt in AUTH_OPTIONS"
            :key="opt.value"
            class="flex cursor-pointer items-start gap-2 text-sm text-ink"
          >
            <input v-model="draft.authType" type="radio" :value="opt.value" class="mt-1 accent-primary" />
            <span>
              {{ opt.label }}
              <span class="block text-xs text-ink-faint">{{ opt.hint }}</span>
            </span>
          </label>
        </div>

        <template v-if="draft.authType === 'header'">
          <label class="text-sm text-ink-secondary">请求头名</label>
          <input
            v-model="draft.headerName"
            type="text"
            placeholder="例如 X-Api-Key"
            class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
          />
        </template>

        <template v-if="draft.authType !== 'none' && draft.authType !== 'hmac'">
          <label class="text-sm text-ink-secondary">{{ draft.authType === 'bearer' ? '令牌' : '请求头的值' }}</label>
          <div class="flex items-center gap-2">
            <input
              v-model="draft.token"
              :type="showToken ? 'text' : 'password'"
              placeholder="粘贴对方给你的值"
              class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-card"
              @click="showToken = !showToken"
            >
              <AppIcon :name="showToken ? 'visibility-off' : 'visibility'" :size="14" />
              {{ showToken ? '隐藏' : '显示' }}
            </button>
          </div>
        </template>

        <template v-if="draft.authType === 'hmac'">
          <label class="text-sm text-ink-secondary">AccessKey</label>
          <input
            v-model="draft.accessKey"
            type="text"
            placeholder="对方给的 AccessKey ID（明文，作为 X-AK 发送）"
            class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
          />
          <label class="text-sm text-ink-secondary">SecretKey</label>
          <div class="flex items-center gap-2">
            <input
              v-model="draft.secretKey"
              :type="showToken ? 'text' : 'password'"
              placeholder="对方给的 SecretKey（仅用于本地算签名，不发送出去）"
              class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-card"
              @click="showToken = !showToken"
            >
              <AppIcon :name="showToken ? 'visibility-off' : 'visibility'" :size="14" />
              {{ showToken ? '隐藏' : '显示' }}
            </button>
          </div>
        </template>
      </div>

      <!-- 操作按钮 -->
      <div class="mt-5 flex items-center gap-3">
        <button
          type="button"
          :disabled="draftProbing"
          class="rounded-control border border-primary-border bg-primary-soft px-4 py-2 text-sm font-medium text-primary hover:bg-primary-border disabled:cursor-not-allowed disabled:opacity-50"
          @click="onTest"
        >
          {{ draftProbing ? '正在测试…' : '测试连接' }}
        </button>
        <button
          type="button"
          :disabled="store.dataSourcesSaving"
          class="rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
          @click="onSave"
        >
          {{ store.dataSourcesSaving ? '正在保存…' : '保存' }}
        </button>
        <button
          type="button"
          class="rounded-control border border-line px-4 py-2 text-sm text-ink-secondary hover:bg-card"
          @click="cancelEdit"
        >
          取消
        </button>
      </div>

      <!-- 测试连接反馈（大白话） -->
      <div
        v-if="probeResult && probeTone"
        :class="['mt-4 rounded-card p-4 text-sm', PROBE_STYLE[probeTone].box]"
      >
        <p class="flex items-start gap-2 text-ink">
          <AppIcon
            :name="PROBE_STYLE[probeTone].icon"
            :size="16"
            :class="['mt-0.5 shrink-0', PROBE_STYLE[probeTone].iconCls]"
          />
          <span>{{ probeResult.message }}</span>
        </p>
        <p v-if="probeResult.ok && probeResult.tools.length > 0" class="mt-1 pl-6 text-ink-secondary">
          能查到：{{ probeResult.tools.join('、') }}
        </p>
        <!-- 错误细节收在「查看详情」 -->
        <div v-if="probeResult.detail" class="mt-2 pl-6">
          <button
            type="button"
            class="flex items-center gap-0.5 text-xs text-ink-secondary underline underline-offset-2 hover:text-ink"
            @click="showDetail = !showDetail"
          >
            {{ showDetail ? '收起详情' : '查看详情' }}
            <AppIcon
              name="chevron-right"
              :size="12"
              class="transition-transform"
              :class="showDetail ? 'rotate-90' : ''"
            />
          </button>
          <pre
            v-if="showDetail"
            class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-card p-3 text-xs text-ink-secondary"
          >{{ probeResult.detail }}</pre>
        </div>
      </div>
    </div>
  </section>
</template>
