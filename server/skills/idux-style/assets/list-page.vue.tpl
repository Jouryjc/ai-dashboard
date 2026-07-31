<template>
  <IxThemeProvider :presetTheme="spec.presentation.theme === 'dark' ? 'dark' : 'default'">
    <main
      class="page-shell"
      :class="[
        `navigation-${spec.presentation.navigation}`,
        `density-${spec.presentation.density}`,
        `surface-${spec.presentation.surface}`,
        `toolbar-${spec.presentation.toolbar}`,
        `theme-${spec.presentation.theme}`
      ]"
      :data-summary-count="spec.summaryCards.length"
    >
    <aside v-if="spec.presentation.navigation === 'side'" class="side-navigation" aria-label="业务导航">
      <strong>{{ spec.entityName }}中心</strong>
      <span
        v-for="(item, index) in spec.presentation.navigationItems"
        :key="item"
        :class="{ active: index === 0 }"
      >{{ item }}</span>
    </aside>

    <div class="page-content">
      <nav
        v-if="spec.presentation.navigation === 'top'"
        class="top-navigation"
        aria-label="业务导航"
      >
        <strong>{{ spec.entityName }}中心</strong>
        <span
          v-for="(item, index) in spec.presentation.navigationItems"
          :key="item"
          :class="{ active: index === 0 }"
        >{{ item }}</span>
      </nav>

      <header class="page-heading" aria-labelledby="page-title">
        <div class="heading-copy">
          <p class="eyebrow">业务管理 / {{ spec.entityName }}</p>
          <h1 id="page-title">{{ spec.title }}</h1>
          <p class="subtitle">{{ spec.description }} 当前展示安全演示数据。</p>
        </div>
        <IxButton mode="primary" @click="triggerPrimaryAction">{{ spec.primaryAction }}</IxButton>
      </header>

      <section
        v-if="spec.summaryCards.length > 0"
        class="summary-grid"
        :style="{ '--summary-columns': String(spec.summaryCards.length) }"
        aria-label="页面概览"
      >
        <IxCard
          v-for="card in spec.summaryCards"
          :key="card.label"
          size="sm"
          class="summary-card"
        >
          <span>{{ card.label }}</span>
          <strong :class="card.tone">
            {{ card.label === '筛选结果' ? filteredRows.length : card.value }}
          </strong>
          <small>{{ card.helper }}</small>
        </IxCard>
      </section>

      <IxCard class="table-card" aria-labelledby="records-title">
        <div class="table-toolbar" :class="`toolbar-${spec.presentation.toolbar}`">
          <div>
            <h2 id="records-title">{{ spec.entityName }}列表</h2>
            <p>共 {{ filteredRows.length }} 条结果</p>
          </div>
          <div class="toolbar-actions">
            <IxInput
              v-model:value="keyword"
              :aria-label="`搜索${spec.entityName}`"
              clearable
              :placeholder="`搜索${spec.entityName}关键字段`"
            />
            <IxButton :loading="loading" @click="refresh">刷新</IxButton>
          </div>
        </div>

        <IxTable
          :columns="columns"
          :dataSource="filteredRows"
          :spin="loading"
          :scroll="{ x: tableScrollWidth }"
        >
          <template #status="{ value }">
            <IxTag :status="statusTone(String(value))" filled>{{ value }}</IxTag>
          </template>
          <template #action="{ record }">
            <div class="row-actions">
              <IxButton mode="link" @click="openDetail(record)">详情</IxButton>
            </div>
          </template>
        </IxTable>
      </IxCard>

      <p class="feedback" role="status" aria-live="polite">{{ feedback }}</p>
    </div>
    </main>
  </IxThemeProvider>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue'
import { IxButton } from '@idux/components/button'
import { IxCard } from '@idux/components/card'
import { IxInput } from '@idux/components/input'
import { IxTable } from '@idux/components/table'
import type { TableColumn } from '@idux/components/table'
import { IxTag } from '@idux/components/tag'
import { IxThemeProvider } from '@idux/components/theme'

type Row = Record<string, string | number> & { key: string }

const spec = __IDUX_SPEC_JSON__
const columns = __IDUX_COLUMNS_JSON__ as TableColumn<Row>[]
const rows = ref<Row[]>(__IDUX_ROWS_JSON__)
const tableScrollWidth = __IDUX_SCROLL_WIDTH__
const keyword = ref('')
const loading = ref(false)
const feedback = ref('')

const filteredRows = computed(() => {
  const search = keyword.value.trim().toLowerCase()
  if (!search) return rows.value
  return rows.value.filter(row =>
    Object.values(row).some(value => String(value).toLowerCase().includes(search))
  )
})

function statusTone(value: string): 'success' | 'warning' | 'error' | 'normal' {
  if (/完成|正常|启用|成功|运行中/.test(value)) return 'success'
  if (/待|进行|处理|暂停|关注/.test(value)) return 'warning'
  if (/失败|异常|取消|停用|停止/.test(value)) return 'error'
  return 'normal'
}

function firstValue(row: Row): string {
  return String(row[Object.keys(row).find(key => key !== 'key') ?? 'key'])
}

function triggerPrimaryAction(): void {
  feedback.value = `${spec.primaryAction}操作已触发（演示页面未连接真实业务系统）`
}

function openDetail(row: Row): void {
  feedback.value = `正在查看：${firstValue(row)}`
}

function refresh(): void {
  loading.value = true
  feedback.value = ''
  window.setTimeout(() => {
    loading.value = false
    feedback.value = '演示数据已刷新'
  }, 500)
}
</script>

<style scoped src="./page-shell.css"></style>
