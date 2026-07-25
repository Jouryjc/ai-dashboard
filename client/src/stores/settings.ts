/**
 * 设置中心数据源：模型设置 + 测试连接。
 * 用法：
 *   const settings = useSettingsStore()
 *   onMounted(() => settings.load())
 *   settings.settings.model = '...'  // 表单直接双向绑定
 *   await settings.save()            // 保存当前表单
 *   await settings.testConnection()  // 结果在 settings.probe，大白话文案直接用
 *   settings.isMultimodal            // false 时 📎 置灰 + 提示换模型
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { ModelSettings, ProbeResult } from '../types'

/** 空白默认值（load 之前的表单初值） */
const EMPTY: ModelSettings = {
  provider: '公司内置',
  apiBase: '',
  apiKey: '',
  model: '',
  plannerModel: '',
  coderModel: '',
  visionModel: ''
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

  return {
    settings, loaded, saving, testing, probe,
    isMultimodal, statusLine,
    load, save, testConnection
  }
})
