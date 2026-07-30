<!--
  LoopEngine 流程图调试面板（v2：真正的有向图，不再是竖向列表）：
  画出引擎的真实拓扑——主流水线 + check 分叉 + repair↔check 回路。
  - SVG 节点框（圆角矩形）+ 箭头连线，节点固定坐标布局（create/edit 流程结构固定）
  - 状态配色：done绿边框 / active蓝边框+呼吸 / failed红 / pending灰
  - 高亮 current 指针节点（加粗边框 + ●标记）
  - 边按"是否走过/正在走"着色：走过=实线主题色，未走过=虚线灰
  - check 的分叉边标 guard（isPassed），让"为什么走 repair 不走 finish"可见
  - 下方节点详情面板：点击节点看脱敏决策摘要（需求理解/匹配理由/发现问题/修了几次…）
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { GraphSnapshot } from '../../types'

const props = defineProps<{
  graph: GraphSnapshot | null
}>()

/* ---------- 流程图布局：节点固定坐标（viewBox 0 0 520 320） ----------
   主流水线横向 5 个节点，check 在右侧偏上是分叉点，repair 在 check 下方，finish 在最右。
   planner(40)  match(140)  fetch(240)  coder(340)  check(440)
                                                            ↗ finish(440,y=40)
                                                       ↘ repair(440,y=240) ↗ (回路回 check)
   节点框宽 80 高 36，中心点坐标如下：*/
interface NodePos { cx: number; cy: number }
const NODE_W = 86
const NODE_H = 38
const POS: Record<string, NodePos> = {
  planner: { cx: 60, cy: 140 },
  match: { cx: 170, cy: 140 },
  fetch: { cx: 280, cy: 140 },
  coder: { cx: 390, cy: 140 },
  check: { cx: 500, cy: 140 },
  repair: { cx: 500, cy: 250 },
  finish: { cx: 500, cy: 40 },
  // edit 流程节点（fallback：线性排列）
  editCoder: { cx: 100, cy: 160 },
  editCheck: { cx: 280, cy: 160 },
  editRepair: { cx: 280, cy: 250 },
  editFinish: { cx: 460, cy: 160 }
}

/** 节点框左上角坐标 */
function boxPos(id: string): { x: number; y: number } {
  const p = POS[id] ?? { cx: 260, cy: 160 }
  return { x: p.cx - NODE_W / 2, y: p.cy - NODE_H / 2 }
}

/* ---------- 边的绘制：起止点 + 路径 + 是否"活跃"（走过/正在走） ---------- */
interface EdgeDraw { id: string; d: string; active: boolean; guard?: string; labelX: number; labelY: number }

/** 判断一条边是否"活跃"（已走过或当前正要走的）：from 节点 done/failed 且 to 非 pending */
function isEdgeActive(from: string, to: string): boolean {
  if (!props.graph) return false
  const fn = props.graph.nodes.find((n) => n.id === from)
  const tn = props.graph.nodes.find((n) => n.id === to)
  if (!fn || !tn) return false
  // from 已完成/失败，且 to 已经被触及（非 pending）= 走过
  if ((fn.status === 'done' || fn.status === 'failed') && tn.status !== 'pending') return true
  // from 是 current 且 to 是 current 的下一个候选（current=from 时标亮出边）
  if (props.graph.current === from) return true
  return false
}

/** 计算所有边的绘制数据（路径 d、标签位置、是否活跃） */
const edges = computed<EdgeDraw[]>(() => {
  if (!props.graph) return []
  const out: EdgeDraw[] = []
  for (let i = 0; i < props.graph.edges.length; i++) {
    const e = props.graph.edges[i]
    const from = POS[e.from] ?? { cx: 260, cy: 160 }
    const to = POS[e.to] ?? { cx: 260, cy: 160 }
    // 起止点贴节点框边缘
    const active = isEdgeActive(e.from, e.to)
    let d: string
    let labelX: number
    let labelY: number

    if (e.from === 'check' && e.to === 'finish') {
      // check→finish：向上
      d = `M ${from.cx},${from.cy - NODE_H / 2} L ${to.cx},${to.cy + NODE_H / 2}`
      labelX = from.cx + 14
      labelY = (from.cy + to.cy) / 2
    } else if (e.from === 'check' && e.to === 'repair') {
      // check→repair：向下
      d = `M ${from.cx},${from.cy + NODE_H / 2} L ${to.cx},${to.cy - NODE_H / 2}`
      labelX = from.cx + 14
      labelY = (from.cy + to.cy) / 2
    } else if (e.from === 'repair' && e.to === 'check') {
      // repair→check：回路，向左绕一下（贝塞尔曲线）
      d = `M ${from.cx - NODE_W / 2},${from.cy} C ${from.cx - 60},${from.cy} ${to.cx - 60},${to.cy} ${to.cx - NODE_W / 2},${to.cy}`
      labelX = from.cx - 70
      labelY = (from.cy + to.cy) / 2 + 4
    } else if (e.from === 'editRepair' && e.to === 'editCheck') {
      d = `M ${from.cx - NODE_W / 2},${from.cy} C ${from.cx - 60},${from.cy} ${to.cx - 60},${to.cy} ${to.cx - NODE_W / 2},${to.cy}`
      labelX = from.cx - 70
      labelY = (from.cy + to.cy) / 2 + 4
    } else {
      // 默认：横向直线
      d = `M ${from.cx + NODE_W / 2},${from.cy} L ${to.cx - NODE_W / 2},${to.cy}`
      labelX = (from.cx + to.cx) / 2
      labelY = from.cy - 6
    }
    out.push({ id: `e${i}`, d, active, guard: e.guard, labelX, labelY })
  }
  return out
})

/** 节点状态 → 边框色（SVG stroke 属性值，用 CSS 变量与全局配色对齐） */
function nodeStroke(status: string, isCurrent: boolean): string {
  if (isCurrent) return 'var(--color-primary)'
  switch (status) {
    case 'done': return 'var(--color-status-done)'
    case 'skipped': return 'var(--color-line-strong)' // 跳过：灰边框（虚线感）
    case 'active': return 'var(--color-status-generating)'
    case 'failed': return 'var(--color-status-attention)'
    default: return 'var(--color-line-strong)'
  }
}
/** 节点状态 → 填充底色（浅底） */
function nodeFill(status: string): string {
  switch (status) {
    case 'done': return '#E8F8EE' // 绿浅底（无对应 token，就近取）
    case 'skipped': return 'var(--color-panel)' // 跳过：与底色一致，靠虚线边框区分
    case 'active': return 'var(--color-primary-soft)'
    case 'failed': return 'var(--color-status-attention-soft)'
    default: return 'var(--color-panel)'
  }
}
/** 节点状态 → 文字色 */
function nodeTextColor(status: string, isCurrent: boolean): string {
  if (isCurrent) return 'var(--color-primary)'
  switch (status) {
    case 'done': return 'var(--color-status-done)'
    case 'skipped': return 'var(--color-ink-faint)' // 跳过：弱化文字
    case 'active': return 'var(--color-status-generating)'
    case 'failed': return 'var(--color-status-attention)'
    default: return 'var(--color-ink-faint)'
  }
}
/** 边框粗细 */
function nodeStrokeWidth(isCurrent: boolean, status: string): number {
  if (isCurrent) return 2.5
  return status === 'pending' ? 1.5 : 2
}
/** 边框是否虚线（skipped 用虚线表示"未执行"） */
function nodeStrokeDash(status: string): string {
  return status === 'skipped' ? '4 3' : 'none'
}

/* ---------- 节点详情面板 ---------- */
const selectedId = ref<string | null>(null)
const selectedNode = computed(() => {
  if (!props.graph || !selectedId.value) return null
  return props.graph.nodes.find((n) => n.id === selectedId.value) ?? null
})
/** 默认选中 current 节点 */
const effectiveSelected = computed(() => selectedNode.value ?? props.graph?.nodes.find((n) => n.id === props.graph?.current) ?? null)

/** 选中节点的出边（展示转移条件） */
const selectedOutEdges = computed(() => {
  if (!props.graph || !effectiveSelected.value) return []
  return props.graph.edges.filter((e) => e.from === effectiveSelected.value!.id)
})

/** 当前指针节点名（模板里 find 会被 TS 判 null，抽出来更稳） */
const currentNodeName = computed(() => {
  if (!props.graph?.current) return ''
  return props.graph.nodes.find((n) => n.id === props.graph!.current)?.name ?? props.graph.current
})

function selectNode(id: string): void {
  selectedId.value = selectedId.value === id ? null : id
}

/** 摘要值格式化 */
function fmtVal(v: string | number | boolean | null): string {
  if (v === null) return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}
</script>

<template>
  <div v-if="!graph" class="mt-8 text-center text-sm leading-6 text-ink-faint">
    还没有流程数据<br />发起一个大屏任务后，这里会显示 Loop 流程图
  </div>

  <div v-else class="flex flex-col gap-3">
    <!-- 指针/挂起状态条 -->
    <div v-if="graph.awaiting" class="rounded-control bg-status-attention-soft px-3 py-2 text-xs text-status-attention">
      ⏸ 已挂起：{{ graph.awaiting }}（等人处理）
    </div>
    <div v-else-if="graph.current" class="text-xs text-ink-faint">
      当前执行：<span class="font-medium text-primary">{{ currentNodeName }}</span>
    </div>

    <!-- SVG 流程图 -->
    <div class="overflow-x-auto rounded-control border border-line bg-panel/50 p-2">
      <svg viewBox="0 0 580 300" class="w-full min-w-[480px]" style="max-height: 280px">
        <defs>
          <!-- 箭头标记：活跃（主题色） -->
          <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-primary)" />
          </marker>
          <!-- 箭头标记：非活跃（灰） -->
          <marker id="arrow-idle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-line-strong)" />
          </marker>
        </defs>

        <!-- 边（先画，在节点下层） -->
        <g v-for="e in edges" :key="e.id">
          <path
            :d="e.d"
            fill="none"
            :stroke="e.active ? 'var(--color-primary)' : 'var(--color-line-strong)'"
            :stroke-width="e.active ? 2 : 1.2"
            :stroke-dasharray="e.active ? 'none' : '4 3'"
            :marker-end="e.active ? 'url(#arrow-active)' : 'url(#arrow-idle)'"
          />
          <!-- guard 标签（check 的分叉边） -->
          <text
            v-if="e.guard"
            :x="e.labelX" :y="e.labelY"
            fill="var(--color-ink-faint)"
            font-size="9"
            text-anchor="middle"
          >guard:{{ e.guard }}</text>
        </g>

        <!-- 节点框 -->
        <g
          v-for="n in graph.nodes"
          :key="n.id"
          class="cursor-pointer"
          @click="selectNode(n.id)"
        >
          <rect
            :x="boxPos(n.id).x" :y="boxPos(n.id).y"
            :width="NODE_W" :height="NODE_H" rx="6"
            :fill="nodeFill(n.status)"
            :stroke="nodeStroke(n.status, n.id === graph.current)"
            :stroke-width="nodeStrokeWidth(n.id === graph.current, n.status)"
            :stroke-dasharray="nodeStrokeDash(n.status)"
          />
          <!-- 当前指针标记小圆点 -->
          <circle
            v-if="n.id === graph.current"
            :cx="boxPos(n.id).x + NODE_W - 6" :cy="boxPos(n.id).y + 6" r="2.5"
            fill="var(--color-primary)"
          >
            <animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite" />
          </circle>
          <!-- 节点名 -->
          <text
            :x="POS[n.id]?.cx ?? 260" :y="(POS[n.id]?.cy ?? 160) + 4"
            :fill="nodeTextColor(n.status, n.id === graph.current)"
            :font-weight="n.id === graph.current ? 600 : 400"
            text-anchor="middle"
            style="font-size: 11px"
          >{{ n.name }}</text>
        </g>
      </svg>
    </div>

    <!-- 图例 -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
      <span class="flex items-center gap-1"><span class="inline-block h-2 w-3 border-2 border-status-done" />已完成</span>
      <span class="flex items-center gap-1"><span class="inline-block h-2 w-3 border-2 border-status-generating" />进行中</span>
      <span class="flex items-center gap-1"><span class="inline-block h-2 w-3 border-[1.5px] border-line-strong" />未开始</span>
      <span class="flex items-center gap-1"><span class="inline-block h-2 w-3 border-2 border-dashed border-line-strong" />已跳过</span>
      <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-3 border-t-2 border-primary" />走过的边</span>
      <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-3 border-t border-dashed border-line-strong" />未走的边</span>
    </div>

    <!-- 节点决策详情（点击节点选中后展示） -->
    <div v-if="effectiveSelected" class="rounded-control border border-line bg-panel p-3">
      <p class="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
        {{ effectiveSelected.name }}
        <span
          class="rounded px-1.5 py-0.5 text-[10px]"
          :class="{
            'bg-status-done-soft text-status-done': effectiveSelected.status === 'done',
            'bg-primary-soft text-status-generating': effectiveSelected.status === 'active',
            'bg-status-attention-soft text-status-attention': effectiveSelected.status === 'failed',
            'bg-line text-ink-faint': effectiveSelected.status === 'skipped' || effectiveSelected.status === 'pending'
          }"
        >{{ effectiveSelected.status === 'skipped' ? '已跳过' : effectiveSelected.status === 'pending' ? '未开始' : effectiveSelected.status === 'done' ? '已完成' : effectiveSelected.status === 'active' ? '进行中' : '失败' }}</span>
        <span v-if="effectiveSelected.id === graph.current" class="text-[10px] text-primary">● 当前指针</span>
      </p>

      <dl v-if="Object.keys(effectiveSelected.summary).length > 0" class="flex flex-col gap-1.5">
        <div v-for="(v, k) in effectiveSelected.summary" :key="String(k)" class="flex items-start gap-2 text-xs leading-5">
          <dt class="shrink-0 text-ink-faint">{{ k }}</dt>
          <dd class="min-w-0 break-all text-ink-secondary">{{ fmtVal(v) }}</dd>
        </div>
      </dl>
      <p v-else class="text-xs text-ink-faint">该节点尚未产出（等待执行）</p>

      <!-- 该节点的出边/转移条件 -->
      <div v-if="selectedOutEdges.length > 0" class="mt-2 border-t border-line pt-2">
        <p class="mb-1 text-[10px] text-ink-faint">转移条件（出边）</p>
        <ul class="flex flex-col gap-0.5">
          <li
            v-for="(e, ei) in selectedOutEdges"
            :key="ei"
            class="flex items-center gap-1 text-[11px] text-ink-faint"
          >
            <span>→ {{ graph.nodes.find(n => n.id === e.to)?.name ?? e.to }}</span>
            <span v-if="e.guard" class="rounded bg-line px-1 text-[10px]">guard: {{ e.guard }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
