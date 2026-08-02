<script setup lang="ts">
/**
 * 设置中心 · 模型设置面板（一期重点，UX §6）。
 * 小白只需填 4 个字段：服务商 / API 地址 / API Key / 模型。
 * 「测试连接」反馈三种大白话（✅ / ⚠ / ❌），错误细节收进「查看详情」。
 * 「高级 ▸」折叠区：按角色指定模型（规划 / 编码 / 视觉）。
 * 数据源：useSettingsStore（表单直接 v-model s.settings.*）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import AppIcon from '../common/AppIcon.vue'

const emit = defineEmits<{ saved: [] }>()

const store = useSettingsStore()

/* ---------- 高级：按角色单独配置（规划 / 编码 / 视觉） ---------- */
type RoleKey = 'planner' | 'coder' | 'vision'
const ROLE_KEYS: RoleKey[] = ['planner', 'coder', 'vision']
const ROLE_LABELS: Record<RoleKey, string> = {
  planner: '规划模型',
  coder: '编码模型',
  vision: '视觉模型'
}
/** 该角色是否「单独配置」（false = 跟随主模型，角色三项配置保持全空） */
const roleCustom = reactive<Record<RoleKey, boolean>>({ planner: false, coder: false, vision: false })
/** 各角色的 Key 明文开关 */
const showRoleKey = reactive<Record<RoleKey, boolean>>({ planner: false, coder: false, vision: false })

/** 切回「跟随主模型」时清空该角色的独立配置 */
function onRoleModeChange(role: RoleKey): void {
  if (!roleCustom[role]) {
    store.settings[role] = { model: '', apiBase: '', apiKey: '' }
  }
}

onMounted(async () => {
  await store.load()
  // 已保存过独立配置的角色，展开为「单独配置」
  for (const role of ROLE_KEYS) {
    const c = store.settings[role]
    roleCustom[role] = Boolean(c?.model || c?.apiBase || c?.apiKey)
  }
})

/* ---------- 预设选项（界面层展示用，不写进类型契约） ---------- */
const PROVIDERS = ['公司内置', 'OpenAI 兼容', '自定义']
/** 选预设服务商时，地址为空则帮用户填好（小白少打字） */
const PROVIDER_DEFAULT_BASE: Record<string, string> = {
  公司内置: 'https://llm.internal.example.com',
  'OpenAI 兼容': 'https://api.openai.com/v1'
}
const MODEL_PRESETS = [
  'qwen2.5-72b-instruct',
  'qwen2.5-vl-72b-instruct',
  'qwen2.5-72b-text-instruct',
  'gpt-4o',
  'gpt-4o-mini'
]
/** 模型候选 = 预设 + 当前值（可从列表选，也可直接打字输入；防保存过的自定义模型名丢失） */
const modelOptions = computed(() => {
  const list = [...MODEL_PRESETS]
  if (store.settings.model && !list.includes(store.settings.model)) {
    list.unshift(store.settings.model)
  }
  return list
})

/* ---------- 本地 UI 状态 ---------- */
const showKey = ref(false)
const showAdvanced = ref(false)
const showDetail = ref(false)

/**
 * 服务端出于安全只回传打码后的 Key（如 sk-…9xyz 或 ******）。
 * 框里是打码值时给用户一句提示：不动它就保持不变，避免误以为是明文又手滑改掉。
 * 打码值原样回传即可，服务端会识别并保留原 Key，客户端无需额外处理。
 */
function isMaskedKey(v: string): boolean {
  return v === '******' || v.includes('…')
}

function onProviderChange(): void {
  const preset = PROVIDER_DEFAULT_BASE[store.settings.provider]
  if (preset && !store.settings.apiBase) {
    store.settings.apiBase = preset
  }
}

/* ---------- 当前状态行 ---------- */
/** check-circle 连接正常 / error 连不上 / 灰点 尚未测试 */
const statusIcon = computed<{ icon: string | null; cls: string }>(() => {
  const p = store.probe
  if (!p) return { icon: null, cls: 'bg-line-strong' }
  return p.ok
    ? { icon: 'check-circle', cls: 'text-status-done' }
    : { icon: 'error', cls: 'text-danger' }
})

/* ---------- 测试连接反馈（三种大白话） ---------- */
type ProbeTone = 'ok' | 'warn' | 'fail'
const probeTone = computed<ProbeTone | null>(() => {
  const p = store.probe
  if (!p) return null
  if (p.ok && p.supportsVision) return 'ok'
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
  showDetail.value = false
  await store.testConnection()
}

async function onSave(): Promise<void> {
  await store.save()
  emit('saved')
}
</script>

<template>
  <section class="rounded-card border border-line bg-card p-6 shadow-card">
    <h2 class="text-base font-semibold text-ink">模型设置</h2>

    <!-- 当前状态行 -->
    <p class="mt-2 flex items-center gap-1.5 text-sm text-ink-secondary">
      当前使用：{{ store.statusLine }}
      <AppIcon v-if="statusIcon.icon" :name="statusIcon.icon" :size="14" :class="statusIcon.cls" />
      <span v-else class="inline-block h-1.5 w-1.5 rounded-full" :class="statusIcon.cls" aria-hidden="true"></span>
      <span v-if="store.probe?.ok" class="text-status-done">连接正常</span>
      <span v-else-if="store.probe && !store.probe.ok" class="text-danger">连不上</span>
      <span v-else class="text-ink-faint">尚未测试连接</span>
    </p>

    <hr class="my-5 border-line" />

    <!-- 四个字段表单 -->
    <div class="grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-4">
      <label class="text-sm text-ink-secondary">服务商</label>
      <select
        v-model="store.settings.provider"
        class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
        @change="onProviderChange"
      >
        <option v-for="p in PROVIDERS" :key="p" :value="p">{{ p }}</option>
      </select>

      <label class="text-sm text-ink-secondary">API 地址</label>
      <input
        v-model="store.settings.apiBase"
        type="text"
        placeholder="例如 https://llm.internal.example.com"
        class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
      />

      <label class="text-sm text-ink-secondary">API Key</label>
      <div class="flex items-center gap-2">
        <input
          v-model="store.settings.apiKey"
          :type="showKey ? 'text' : 'password'"
          placeholder="粘贴你的 Key"
          class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-panel"
          @click="showKey = !showKey"
        >
          <AppIcon :name="showKey ? 'visibility-off' : 'visibility'" :size="14" />
          {{ showKey ? '隐藏' : '显示' }}
        </button>
      </div>
      <p v-if="isMaskedKey(store.settings.apiKey)" class="text-xs text-ink-faint">
        已保存密钥，这里打码显示。不动它就保持不变；输入新 Key 会更换；清空会删除。
      </p>

      <label class="text-sm text-ink-secondary">模型</label>
      <!-- 可从列表选，也可直接打字输入模型名（如 qwen2.5-72b-text-instruct 这类不看图片的模型） -->
      <input
        v-model="store.settings.model"
        type="text"
        list="model-preset-options"
        placeholder="从列表选，或直接输入模型名"
        class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
      />
      <datalist id="model-preset-options">
        <option v-for="m in modelOptions" :key="m" :value="m" />
      </datalist>
    </div>

    <!-- 操作按钮 -->
    <div class="mt-6 flex items-center gap-3">
      <button
        type="button"
        :disabled="store.testing"
        class="rounded-control border border-primary-border bg-primary-soft px-4 py-2 text-sm font-medium text-primary hover:bg-primary-border disabled:cursor-not-allowed disabled:opacity-50"
        @click="onTest"
      >
        {{ store.testing ? '正在测试…' : '测试连接' }}
      </button>
      <button
        type="button"
        :disabled="store.saving"
        class="rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
        @click="onSave"
      >
        {{ store.saving ? '正在保存…' : '保存设置' }}
      </button>
    </div>

    <!-- 测试连接反馈（大白话） -->
    <div
      v-if="store.probe && probeTone"
      :class="['mt-4 rounded-card p-4 text-sm', PROBE_STYLE[probeTone].box]"
    >
      <p class="flex items-start gap-2 text-ink">
        <AppIcon :name="PROBE_STYLE[probeTone].icon" :size="16" :class="['mt-0.5 shrink-0', PROBE_STYLE[probeTone].iconCls]" />
        <span>{{ store.probe.message }}</span>
      </p>
      <!-- 错误细节收在「查看详情」 -->
      <div v-if="store.probe.detail" class="mt-2 pl-6">
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
          class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-panel p-3 text-xs text-ink-secondary"
        >{{ store.probe.detail }}</pre>
      </div>
    </div>

    <!-- 高级 ▸（按角色单独配置） -->
    <div class="mt-6 border-t border-line pt-4">
      <button
        type="button"
        class="flex items-center gap-1 text-sm font-medium text-ink-secondary hover:text-ink"
        @click="showAdvanced = !showAdvanced"
      >
        <AppIcon
          name="chevron-right"
          :size="14"
          :class="['inline-block transition-transform', showAdvanced ? 'rotate-90' : '']"
        />
        高级（按角色单独配置：规划 / 编码 / 视觉）
      </button>
      <p v-if="showAdvanced" class="mt-2 text-xs text-ink-faint">
        不懂就不用管，默认都跟随上面的主模型。选「单独配置」后，可以只换模型，也可以连地址和 Key 一起换；留空的项目仍跟随上面。
      </p>
      <div
        v-if="showAdvanced"
        class="mt-3 grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-3"
      >
        <template v-for="role in ROLE_KEYS" :key="role">
          <label class="text-sm text-ink-secondary">{{ ROLE_LABELS[role] }}</label>
          <select
            v-model="roleCustom[role]"
            class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
            @change="onRoleModeChange(role)"
          >
            <option :value="false">跟随主模型</option>
            <option :value="true">单独配置</option>
          </select>

          <template v-if="roleCustom[role]">
            <label class="pl-3 text-xs text-ink-faint">模型</label>
            <input
              v-model="store.settings[role].model"
              type="text"
              list="model-preset-options"
              placeholder="从列表选，或直接输入模型名"
              class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
            />

            <label class="pl-3 text-xs text-ink-faint">API 地址</label>
            <input
              v-model="store.settings[role].apiBase"
              type="text"
              placeholder="留空则跟随上面的 API 地址"
              class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
            />

            <label class="pl-3 text-xs text-ink-faint">API Key</label>
            <div class="flex items-center gap-2">
              <input
                v-model="store.settings[role].apiKey"
                :type="showRoleKey[role] ? 'text' : 'password'"
                placeholder="留空则跟随上面的 API Key"
                class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-panel"
                @click="showRoleKey[role] = !showRoleKey[role]"
              >
                <AppIcon :name="showRoleKey[role] ? 'visibility-off' : 'visibility'" :size="14" />
                {{ showRoleKey[role] ? '隐藏' : '显示' }}
              </button>
            </div>
            <p v-if="isMaskedKey(store.settings[role].apiKey)" class="col-start-2 pl-3 text-xs text-ink-faint">
              已保存密钥，这里打码显示。不动它就保持不变；输入新 Key 会更换；清空则跟随上面的 API Key。
            </p>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>
