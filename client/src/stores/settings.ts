/**
 * 设置中心数据源：模型设置 + 测试连接 + 数据源（MCP）管理。
 * 用法：
 *   const settings = useSettingsStore()
 *   onMounted(() => settings.load())
 *   settings.settings.model = '...'  // 表单直接双向绑定
 *   await settings.save()            // 保存当前表单
 *   await settings.testConnection()  // 结果在 settings.probe，大白话文案直接用
 *   settings.isMultimodal            // false 时 📎 置灰 + 提示换模型
 *   onMounted(() => settings.loadDataSources())  // 数据源列表独立加载/保存
 *   await settings.probeDataSource(draft)        // 测试某个数据源，probing[id] 标记进行中
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { DataSourceProbeResult, McpDataSource, ModelSettings, ProbeResult, PublishConfig, RoleModelConfig } from '../types'

/** 空白角色配置（留空 = 跟随主设置） */
const EMPTY_ROLE: RoleModelConfig = { model: '', apiBase: '', apiKey: '' }

/** 空白默认值（load 之前的表单初值） */
const EMPTY: ModelSettings = {
  provider: '公司内置',
  apiBase: '',
  apiKey: '',
  model: '',
  planner: { ...EMPTY_ROLE },
  coder: { ...EMPTY_ROLE },
  vision: { ...EMPTY_ROLE }
}

export const useSettingsStore = defineStore('settings', () => {
  /* ---------- state ---------- */
  /** 模型设置表单（直接 v-model 绑定） */
  const settings = ref<ModelSettings>({ ...EMPTY })
  /** 是否已加载 */
  const loaded = ref(false)
  /** 保存中 */
  const saving = ref(false)
  /** 测试连接中 */
  const testing = ref(false)
  /** 最近一次测试结果（大白话结论；未测过 = null） */
  const probe = ref<ProbeResult | null>(null)

  /* ---------- getters ---------- */
  /** 当前是否多模态模式（测试结果支持图片理解）；未测试过默认按支持处理 */
  const isMultimodal = computed(() => probe.value?.supportsVision ?? true)
  /** 顶栏/设置页一句话状态，如 "公司内置模型 · 连接正常" */
  const statusLine = computed(() => {
    if (!probe.value) return `${settings.value.provider}模型`
    return probe.value.ok
      ? `${settings.value.provider}模型 · 连接正常`
      : `${settings.value.provider}模型 · 连不上`
  })

  /* ---------- actions ---------- */
  /** 读取设置（幂等） */
  async function load(): Promise<void> {
    settings.value = await api.getSettings()
    loaded.value = true
  }

  /** 最近一次测试时的表单快照（判断保存后旧测试结果是否仍然可信） */
  let testedFingerprint: string | null = null

  /** 保存当前表单 */
  async function save(): Promise<void> {
    saving.value = true
    try {
      const snapshot = { ...settings.value }
      await api.saveSettings(snapshot)
      // 保存的内容和刚测试过的完全一致时，测试结果仍然可信（⚠/✅ 状态保留）；
      // 否则旧测试结果不再可信
      if (JSON.stringify(snapshot) !== testedFingerprint) {
        probe.value = null
      }
    } finally {
      saving.value = false
    }
  }

  /** 测试连接（用当前表单内容，结果写入 probe，文案直接展示 probe.message） */
  async function testConnection(): Promise<void> {
    testing.value = true
    try {
      const snapshot = { ...settings.value }
      probe.value = await api.testConnection(snapshot)
      testedFingerprint = JSON.stringify(snapshot)
    } finally {
      testing.value = false
    }
  }

  /* ---------- 数据源（独立于模型设置的 load/save，全量列表风格） ---------- */
  /** 数据源列表 */
  const dataSources = ref<McpDataSource[]>([])
  /** 数据源是否已加载 */
  const dataSourcesLoaded = ref(false)
  /** 数据源保存中 */
  const dataSourcesSaving = ref(false)
  /** 每个数据源的「测试连接」进行中标记（按数据源 id 记） */
  const probing = ref<Record<string, boolean>>({})

  /** 读取数据源列表（幂等） */
  async function loadDataSources(): Promise<void> {
    dataSources.value = await api.getDataSources()
    dataSourcesLoaded.value = true
  }

  /** 全量保存数据源列表；不传时用当前 state（保存后 state 与存档一致） */
  async function saveDataSources(list?: McpDataSource[]): Promise<void> {
    dataSourcesSaving.value = true
    try {
      const snapshot = (list ?? dataSources.value).map((s) => ({ ...s }))
      await api.saveDataSources(snapshot)
      dataSources.value = snapshot
    } finally {
      dataSourcesSaving.value = false
    }
  }

  /** 测试某个数据源连接（草稿即可，无需先保存；结果由调用方展示） */
  async function probeDataSource(source: McpDataSource): Promise<DataSourceProbeResult> {
    probing.value = { ...probing.value, [source.id]: true }
    try {
      return await api.probeDataSource({ ...source })
    } finally {
      probing.value = { ...probing.value, [source.id]: false }
    }
  }

  /* ---------- 发布配置（云配置，与模型设置同风格的 load/save） ---------- */
  /** 发布配置表单（直接 v-model 绑定） */
  const publishConfig = ref<PublishConfig>({ endpoint: '', accessKey: '', secretKey: '' })
  /** 发布配置是否已加载 */
  const publishConfigLoaded = ref(false)
  /** 发布配置保存中 */
  const publishConfigSaving = ref(false)

  /** 读取发布配置（幂等） */
  async function loadPublishConfig(): Promise<void> {
    publishConfig.value = await api.getPublishConfig()
    publishConfigLoaded.value = true
  }

  /** 保存当前发布配置 */
  async function savePublishConfig(): Promise<void> {
    publishConfigSaving.value = true
    try {
      const snapshot = { ...publishConfig.value }
      await api.savePublishConfig(snapshot)
      publishConfig.value = snapshot
    } finally {
      publishConfigSaving.value = false
    }
  }

  return {
    settings, loaded, saving, testing, probe,
    isMultimodal, statusLine,
    load, save, testConnection,
    dataSources, dataSourcesLoaded, dataSourcesSaving, probing,
    loadDataSources, saveDataSources, probeDataSource,
    publishConfig, publishConfigLoaded, publishConfigSaving,
    loadPublishConfig, savePublishConfig
  }
})
