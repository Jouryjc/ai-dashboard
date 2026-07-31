/**
 * 大屏流程定义 -- 声明式接入 LoopEngine。
 *
 * 定义 create / edit 两套流程的节点、边（含 guard）、恢复表。
 * 引擎按这些声明调度，业务执行器（executors/）只管每个节点干什么。
 *
 * 节点产出（NodeOutput）的形态约定（业务层，引擎不解释）见各执行器。
 */
import type { FlowDefinition, ResumeTable, GraphState } from '../../../loop-engine/src'

/* ============================== 节点 id 常量 ============================== */

/** create 流程节点 */
export const CREATE_NODES = {
  planner: 'planner',
  match: 'match',
  fetch: 'fetch',
  coder: 'coder',
  check: 'check',
  repair: 'repair',
  finish: 'finish'
} as const

/** edit 流程节点 */
export const EDIT_NODES = {
  editCoder: 'editCoder',
  editCheck: 'editCheck',
  editRepair: 'editRepair',
  editFinish: 'editFinish'
} as const

/** 大屏挂起标记（业务定义的 Tag 值，注入引擎的 awaiting） */
export const SUSPEND_TAGS = {
  clarification: 'clarification',         // 等待用户澄清
  templateConfirm: 'template_confirm',    // 模板无匹配，等用户确认
  datasourceDown: 'datasource_down',      // 数据源连不上
  llmFailure: 'llm_failure',              // LLM 调用失败
  fixOverBudget: 'fix_over_budget',       // 修复超预算
  overtime: 'overtime'                    // 看门狗超时
} as const

/* ============================== create 流程定义 ============================== */

/** create 流程（有数据源时，7 节点） */
export function createFlowWithFetch(): FlowDefinition {
  return {
    nodes: [
      { id: CREATE_NODES.planner, name: '理解需求' },
      { id: CREATE_NODES.match, name: '匹配模板' },
      { id: CREATE_NODES.fetch, name: '获取数据' },
      { id: CREATE_NODES.coder, name: '编写页面' },
      { id: CREATE_NODES.check, name: '视觉检查' },
      { id: CREATE_NODES.repair, name: '修复问题' },
      { id: CREATE_NODES.finish, name: '生成预览' }
    ],
    edges: [
      { from: CREATE_NODES.planner, to: CREATE_NODES.match },
      { from: CREATE_NODES.match, to: CREATE_NODES.fetch },
      { from: CREATE_NODES.fetch, to: CREATE_NODES.coder },
      { from: CREATE_NODES.coder, to: CREATE_NODES.check },
      { from: CREATE_NODES.check, to: CREATE_NODES.finish, guard: 'isPassed' },
      { from: CREATE_NODES.check, to: CREATE_NODES.repair },
      { from: CREATE_NODES.repair, to: CREATE_NODES.check }
    ],
    guards: {
      isPassed: (gs: GraphState) => {
        const ids = gs.nodes[CREATE_NODES.check]?.output?.issueIds
        return Array.isArray(ids) && ids.length === 0
      }
    }
  }
}

/** create 流程（无数据源时，6 节点，去掉 fetch） */
export function createFlowNoFetch(): FlowDefinition {
  return {
    nodes: [
      { id: CREATE_NODES.planner, name: '理解需求' },
      { id: CREATE_NODES.match, name: '匹配模板' },
      { id: CREATE_NODES.coder, name: '编写页面' },
      { id: CREATE_NODES.check, name: '视觉检查' },
      { id: CREATE_NODES.repair, name: '修复问题' },
      { id: CREATE_NODES.finish, name: '生成预览' }
    ],
    edges: [
      { from: CREATE_NODES.planner, to: CREATE_NODES.match },
      { from: CREATE_NODES.match, to: CREATE_NODES.coder },
      { from: CREATE_NODES.coder, to: CREATE_NODES.check },
      { from: CREATE_NODES.check, to: CREATE_NODES.finish, guard: 'isPassed' },
      { from: CREATE_NODES.check, to: CREATE_NODES.repair },
      { from: CREATE_NODES.repair, to: CREATE_NODES.check }
    ],
    guards: {
      isPassed: (gs: GraphState) => {
        const ids = gs.nodes[CREATE_NODES.check]?.output?.issueIds
        return Array.isArray(ids) && ids.length === 0
      }
    }
  }
}

/* ============================== edit 流程定义 ============================== */

/** edit 流程（4 节点：修改 -> 检查 -> [修复 -> 检查] -> 完成） */
export function editFlow(): FlowDefinition {
  return {
    nodes: [
      { id: EDIT_NODES.editCoder, name: '修改' },
      { id: EDIT_NODES.editCheck, name: '检查' },
      { id: EDIT_NODES.editRepair, name: '修复问题' },
      { id: EDIT_NODES.editFinish, name: '生成预览' }
    ],
    edges: [
      { from: EDIT_NODES.editCoder, to: EDIT_NODES.editCheck },
      { from: EDIT_NODES.editCheck, to: EDIT_NODES.editFinish, guard: 'isPassed' },
      { from: EDIT_NODES.editCheck, to: EDIT_NODES.editRepair },
      { from: EDIT_NODES.editRepair, to: EDIT_NODES.editCheck }
    ],
    guards: {
      isPassed: (gs: GraphState) => {
        const ids = gs.nodes[EDIT_NODES.editCheck]?.output?.issueIds
        return Array.isArray(ids) && ids.length === 0
      }
    }
  }
}

/* ============================== 恢复表 ============================== */

/**
 * create 流程恢复表：每种挂起标记恢复时从哪继续。
 * 替代 orchestrator 里 20 处 run.retryLlm/proceed/retryRepair 闭包预埋。
 * hasFetch=false 时去掉 datasource_down 恢复点（无 fetch 节点不会触发该挂起）。
 */
export function createResumeTable(hasFetch = true): ResumeTable {
  const resume: Record<string, { node: string }> = {
    [SUSPEND_TAGS.clarification]: { node: CREATE_NODES.planner },
    [SUSPEND_TAGS.templateConfirm]: { node: CREATE_NODES.match },
    [SUSPEND_TAGS.llmFailure]: { node: 'current' },
    [SUSPEND_TAGS.fixOverBudget]: { node: CREATE_NODES.repair },
    [SUSPEND_TAGS.overtime]: { node: 'current' }
  }
  if (hasFetch) {
    resume[SUSPEND_TAGS.datasourceDown] = { node: CREATE_NODES.fetch }
  }
  return { resume }
}

/** edit 流程恢复表 */
export function editResumeTable(): ResumeTable {
  return {
    resume: {
      [SUSPEND_TAGS.llmFailure]: { node: 'current' },
      [SUSPEND_TAGS.fixOverBudget]: { node: EDIT_NODES.editRepair },
      [SUSPEND_TAGS.overtime]: { node: 'current' }
    }
  }
}

/* ============================== 辅助：流程选择 ============================== */

/** 根据是否有启用的数据源，选 create 流程定义 */
export function selectCreateFlow(hasEnabledDataSources: boolean): FlowDefinition {
  return hasEnabledDataSources ? createFlowWithFetch() : createFlowNoFetch()
}
