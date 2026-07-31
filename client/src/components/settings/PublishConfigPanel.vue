<script setup lang="ts">
/**
 * 设置中心 · 发布配置面板（云配置）。
 * 大屏做好后要发布到云上，需要先在这里填好云的接入信息，三个字段：
 *   endpoint   访问地址（对象存储 / 云服务的入口）
 *   accessKey  访问密钥 ID
 *   secretKey  访问密钥（界面默认打码显示，可点「显示」切换）
 * 数据源：useSettingsStore（表单直接 v-model store.publishConfig.*）
 */
import { onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import AppIcon from '../common/AppIcon.vue'

const emit = defineEmits<{ saved: [] }>()

const store = useSettingsStore()

onMounted(() => store.loadPublishConfig())

/* ---------- 本地 UI 状态 ---------- */
/** secretKey 明文开关（accessKey 一般不算高敏感，沿用普通文本框；secretKey 默认打码） */
const showSecret = ref(false)

async function onSave(): Promise<void> {
  await store.savePublishConfig()
  emit('saved')
}
</script>

<template>
  <section class="rounded-card border border-line bg-card p-6 shadow-card">
    <h2 class="text-base font-semibold text-ink">发布配置</h2>

    <!-- 当前状态行 -->
    <p class="mt-2 flex items-center gap-1.5 text-sm text-ink-secondary">
      填好云的接入信息后，生成好的大屏就能一键发布到云上。
      <span class="text-ink-faint">没有接入信息的话，找运维或云服务管理员要一下。</span>
    </p>

    <hr class="my-5 border-line" />

    <!-- 三个字段表单 -->
    <div class="grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-4">
      <label class="text-sm text-ink-secondary">endpoint</label>
      <input
        v-model="store.publishConfig.endpoint"
        type="text"
        placeholder="例如 https://oss-cn-hangzhou.aliyuncs.com"
        class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
      />

      <label class="text-sm text-ink-secondary">access-key</label>
      <input
        v-model="store.publishConfig.accessKey"
        type="text"
        placeholder="访问密钥 ID，如 LTAI5t..."
        class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
      />

      <label class="text-sm text-ink-secondary">secret-key</label>
      <div class="flex items-center gap-2">
        <input
          v-model="store.publishConfig.secretKey"
          :type="showSecret ? 'text' : 'password'"
          placeholder="访问密钥，默认打码显示"
          class="w-full rounded-control border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded-control border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-panel"
          @click="showSecret = !showSecret"
        >
          <AppIcon :name="showSecret ? 'visibility-off' : 'visibility'" :size="14" />
          {{ showSecret ? '隐藏' : '显示' }}
        </button>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="mt-6 flex items-center gap-3">
      <button
        type="button"
        :disabled="store.publishConfigSaving"
        class="rounded-control bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
        @click="onSave"
      >
        {{ store.publishConfigSaving ? '正在保存…' : '保存设置' }}
      </button>
    </div>
  </section>
</template>
