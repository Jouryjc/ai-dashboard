<script setup lang="ts">
/**
 * 设置中心 —— 模态整页（不新开窗口，UX §6）。
 * 布局：顶部条（← 返回 + 标题）+ 左侧导航（模型/数据源/通知/账户与关于）+ 右侧内容。
 * 一期重点：模型设置（ModelSettingsPanel）+ 数据源（DataSourcePanel）；通知做「即将上线」占位；
 * 账户与关于页含应用信息 + 快捷键一览（UX §8）。
 * 保存成功后在页面底部弹 toast「设置已保存」。
 */
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import ModelSettingsPanel from '../components/settings/ModelSettingsPanel.vue'
import DataSourcePanel from '../components/settings/DataSourcePanel.vue'
import PlaceholderPanel from '../components/settings/PlaceholderPanel.vue'
import ShortcutTable from '../components/settings/ShortcutTable.vue'
import AppIcon from '../components/common/AppIcon.vue'

const router = useRouter()

type NavKey = 'model' | 'datasource' | 'notification' | 'account'
interface NavItem {
  key: NavKey
  label: string
  /** AppIcon 注册名 */
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { key: 'model', label: '模型', icon: 'neurology' },
  { key: 'datasource', label: '数据源', icon: 'database' },
  { key: 'notification', label: '通知', icon: 'notifications' },
  { key: 'account', label: '账户与关于', icon: 'account-circle' }
]

const active = ref<NavKey>('model')

function goBack(): void {
  router.push('/')
}

/* ---------- 保存成功 toast ---------- */
const toastText = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function onSaved(): void {
  toastText.value = '设置已保存'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastText.value = ''
    toastTimer = null
  }, 2500)
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="flex h-full flex-col bg-page">
    <!-- 顶部条 -->
    <header class="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-card px-4">
      <button
        type="button"
        class="rounded-control px-2 py-1 text-sm text-ink-secondary hover:bg-panel hover:text-ink"
        @click="goBack"
      >
        <AppIcon name="arrow-back" :size="14" class="mr-1" />返回
      </button>
      <h1 class="text-base font-semibold text-ink">设置</h1>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- 左侧导航 -->
      <nav class="w-48 shrink-0 border-r border-line bg-panel p-3">
        <button
          v-for="item in NAV_ITEMS"
          :key="item.key"
          type="button"
          :class="[
            'mb-1 flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm',
            active === item.key
              ? 'bg-primary-soft font-medium text-primary'
              : 'text-ink-secondary hover:bg-line/60 hover:text-ink'
          ]"
          @click="active = item.key"
        >
          <AppIcon :name="item.icon" :size="16" class="shrink-0" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <main class="min-w-0 flex-1 overflow-y-auto p-6">
        <div class="mx-auto max-w-3xl space-y-6">
          <ModelSettingsPanel v-if="active === 'model'" @saved="onSaved" />

          <DataSourcePanel v-else-if="active === 'datasource'" @saved="onSaved" />

          <PlaceholderPanel
            v-else-if="active === 'notification'"
            icon="notifications"
            title="通知"
            description="以后可以在这里选择哪些事情要提醒你，比如大屏做好了、需要你处理的问题。"
          />

          <template v-else>
            <section class="rounded-card border border-line bg-card p-6 shadow-card">
              <h2 class="text-base font-semibold text-ink">账户与关于</h2>
              <dl class="mt-4 space-y-3 text-sm">
                <div class="flex items-center justify-between">
                  <dt class="text-ink-secondary">应用名称</dt>
                  <dd class="text-ink">AI 大屏工作台</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-ink-secondary">版本</dt>
                  <dd class="text-ink">v0.1.0（内部体验版）</dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-ink-secondary">遇到问题？</dt>
                  <dd class="text-ink">在工作台右侧点「呼叫人工协助」</dd>
                </div>
              </dl>
            </section>
            <ShortcutTable />
          </template>
        </div>
      </main>
    </div>

    <!-- 保存成功 toast -->
    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="toastText"
        class="fixed bottom-8 left-1/2 -translate-x-1/2 rounded-card bg-ink px-4 py-2 text-sm text-white shadow-pop"
      >
        {{ toastText }}
      </div>
    </transition>
  </div>
</template>
