<!--
  阶段时间线（UX §4.2 右栏 / §5.2）：
  ✓ 已完成（绿）/ ● 进行中（蓝 + 呼吸动画 + 已耗时"x 分 xx 秒"）/ ○ 未开始（灰），节点竖线连接。
  增量修改收敛为 3 步、新建 6~8 步由后端/mock 给的 stages 决定，这里照单渲染。
  每个阶段节点下渲染该阶段的执行轨迹（AgentStep 动作流："Agent 具体干了哪些事"，
  文案由服务端/mock 写入时固化成大白话，这里只渲染不翻译），再往下挂 IssueCard。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AgentStep, Issue, Stage } from '../../types'
import IssueCard from './IssueCard.vue'
import AppIcon from '../common/AppIcon.vue'
import { formatElapsed } from './utils'

const props = withDefaults(defineProps<{
  stages: Stage[]
  issues?: Issue[]
  steps?: AgentStep[]
}>(), { issues: () => [], steps: () => [] })

/* mock 会用空标题槽位抹掉上一轮的尾巴，空标题节点不渲染 */
const visibleStages = computed(() => props.stages.filter((s) => s.title))

/* 进行中阶段的已耗时每秒刷新一次 */
const now = ref(Date.now())
let timer: number | undefined
const hasActive = computed(() => props.stages.some((s) => s.state === 'active'))
onMounted(() => {
  timer = window.setInterval(() => {
    if (hasActive.value) now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})

function issuesOf(stageId: string): Issue[] {
  return props.issues.filter((i) => i.stageId === stageId)
}

function stepsOf(stageId: string): AgentStep[] {
  return props.steps.filter((s) => s.stageId === stageId)
}

/** 阶段耗时：进行中算到现在，已完成算到完成时间 */
function elapsedOf(s: Stage): string {
  if (!s.startedAt) return ''
  const end = s.state === 'done' && s.finishedAt ? s.finishedAt : now.value
  return formatElapsed(end - s.startedAt)
}
</script>

<template>
  <ol class="flex flex-col">
    <li v-for="(s, idx) in visibleStages" :key="s.id" class="relative flex gap-3">
      <!-- 节点圆点 + 连接竖线 -->
      <div class="flex w-4 shrink-0 flex-col items-center">
        <AppIcon
          v-if="s.state === 'done'"
          name="check-circle"
          :size="16"
          class="text-status-done"
        />
        <span
          v-else-if="s.state === 'active'"
          class="h-4 w-4 rounded-full bg-status-generating ring-4 ring-primary-soft animate-pulse-blue"
        />
        <span
          v-else
          class="h-4 w-4 rounded-full border-2 border-line-strong bg-card"
        />
        <span v-if="idx < visibleStages.length - 1" class="mt-1 w-px flex-1 bg-line" />
      </div>

      <!-- 阶段内容 -->
      <div class="min-w-0 flex-1 pb-4">
        <div class="flex items-baseline justify-between gap-2">
          <p
            class="truncate text-sm"
            :class="s.state === 'active'
              ? 'font-medium text-ink'
              : s.state === 'done'
                ? 'text-ink-secondary'
                : 'text-ink-faint'"
          >{{ s.title }}</p>
          <span v-if="s.state === 'active' && elapsedOf(s)" class="shrink-0 text-xs text-status-generating">
            已进行 {{ elapsedOf(s) }}
          </span>
          <span v-else-if="s.state === 'done' && elapsedOf(s)" class="shrink-0 text-xs text-ink-faint">
            用时 {{ elapsedOf(s) }}
          </span>
        </div>

        <!-- 进行中阶段的实时进展（服务端流式推送："正在编写页面…已生成 2,340 字"） -->
        <p
          v-if="s.state === 'active' && s.detail"
          class="mt-1 flex items-center gap-1.5 text-xs text-status-generating"
        >
          <span class="inline-block h-1 w-1 shrink-0 rounded-full bg-status-generating animate-pulse-blue" />
          <span class="truncate">{{ s.detail }}</span>
        </p>

        <!-- 该阶段的执行轨迹（Agent 具体干了哪些事：动作 + 结果摘要） -->
        <ul v-if="stepsOf(s.id).length" class="mt-1.5 flex flex-col gap-1">
          <li
            v-for="step in stepsOf(s.id)"
            :key="step.id"
            class="flex items-start gap-1.5 text-xs leading-4"
          >
            <AppIcon
              v-if="step.state === 'done'"
              name="check-circle"
              :size="12"
              class="mt-0.5 shrink-0 text-status-done"
            />
            <AppIcon
              v-else-if="step.state === 'failed'"
              name="close"
              :size="12"
              class="mt-0.5 shrink-0 text-status-attention"
            />
            <span
              v-else
              class="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-status-generating animate-pulse-blue"
            />
            <span
              class="min-w-0"
              :class="step.state === 'active'
                ? 'text-status-generating'
                : step.state === 'failed'
                  ? 'text-status-attention'
                  : 'text-ink-faint'"
            >{{ step.title }}<template v-if="step.detail"> — {{ step.detail }}</template></span>
          </li>
        </ul>

        <!-- 该阶段发现的问题（缩进挂在节点下） -->
        <div v-if="issuesOf(s.id).length" class="mt-2 flex flex-col gap-2">
          <IssueCard v-for="issue in issuesOf(s.id)" :key="issue.id" :issue="issue" />
        </div>
      </div>
    </li>
  </ol>
</template>
