/**
 * loop-engine 单元测试。
 *
 * 用 stub 节点执行器验证引擎核心机制：
 *   - 线性流程推进 + onCommit
 *   - 条件转移（guard 选边）
 *   - 挂起/恢复与纯 JSON 检查点跨引擎续跑
 *   - 流程版本不匹配和检查点篡改拒绝
 *   - 失败 -> blocked
 *   - restore 载入历史快照
 *   - createLoop 创建时校验
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createLoop, type NodeExecutor, type NodeResult, type GraphState, type FlowDefinition, type ResumeTable, type LoopConfig } from '../src/index'

/* ============================== stub 执行器工具 ============================== */

/** 造一个按预设结果序列执行的 stub 执行器 */
function stubExecutor(results: NodeResult[]): NodeExecutor {
  let i = 0
  return {
    async execute() {
      return results[i++] ?? { kind: 'done' }
    }
  }
}

/** 造一个读 graphState 决定结果的执行器（用于 guard 测试） */
function dynamicExecutor(fn: (gs: GraphState) => NodeResult): NodeExecutor {
  return {
    async execute(ctx) {
      return fn(ctx.graphState)
    }
  }
}

/** 一个空执行器（占位用，配合校验测试） */
const noopExecutor: NodeExecutor = { async execute() { return { kind: 'done' } } }

/** 最简线性流程定义：A -> B -> END */
function linearFlow(): FlowDefinition {
  return {
    nodes: [
      { id: 'a', name: '步骤A' },
      { id: 'b', name: '步骤B' }
    ],
    edges: [
      { from: 'a', to: 'b' }
      // b 无出边 -> 流程结束
    ]
  }
}

const emptyResume: ResumeTable = { resume: {} }

/* ============================== 测试用例 ============================== */

describe('线性流程推进', () => {
  test('start -> a(done) -> b(done) -> onCommit', async () => {
    let committed: GraphState | null = null
    const config: LoopConfig = {
      definition: linearFlow(),
      resume: emptyResume,
      executors: {
        a: stubExecutor([{ kind: 'done', output: { msg: 'a done' } }]),
        b: stubExecutor([{ kind: 'done', output: { msg: 'b done' } }])
      },
      onCommit: async (gs) => { committed = gs }
    }
    const engine = createLoop(config)
    assert.equal(engine.getState(), 'idle')

    await engine.handleEvent({ kind: 'start', initialNode: 'a' })

    assert.equal(engine.getState(), 'idle')
    assert.ok(committed, 'onCommit 应被调用')
    assert.equal(committed!.nodes.a.status, 'done')
    assert.equal(committed!.nodes.b.status, 'done')
    assert.equal(committed!.nodes.a.output?.msg, 'a done')
    assert.equal(committed!.nodes.b.output?.msg, 'b done')
  })

  test('onNodeComplete 在每个节点完成时触发', async () => {
    const completed: string[] = []
    const engine = createLoop({
      definition: linearFlow(),
      resume: emptyResume,
      executors: { a: noopExecutor, b: noopExecutor },
      onCommit: async () => {},
      onNodeComplete: (nodeId) => { completed.push(nodeId) }
    })
    await engine.handleEvent({ kind: 'start', initialNode: 'a' })
    assert.deepEqual(completed, ['a', 'b'])
  })
})

describe('条件转移（guard 选边）', () => {
  /** 流程：check -> [isPassed] finish / check -> repair -> check（回环复检） */
  function checkFlow(): FlowDefinition {
    return {
      nodes: [
        { id: 'check', name: '检查' },
        { id: 'finish', name: '完成' },
        { id: 'repair', name: '修复' }
      ],
      edges: [
        { from: 'check', to: 'finish', guard: 'isPassed' },
        { from: 'check', to: 'repair' },        // 兜底：有问题 -> 修复
        { from: 'repair', to: 'check' }          // 修完复检
      ],
      guards: {
        isPassed: (gs) => (gs.nodes.check.output?.issueCount ?? 1) === 0
      }
    }
  }

  test('检查通过 -> 直接到 finish', async () => {
    let committed = false
    const engine = createLoop({
      definition: checkFlow(),
      resume: emptyResume,
      executors: {
        check: stubExecutor([{ kind: 'done', output: { issueCount: 0 } }]),
        repair: noopExecutor,
        finish: noopExecutor
      },
      onCommit: async () => { committed = true }
    })
    await engine.handleEvent({ kind: 'start', initialNode: 'check' })
    assert.ok(committed, '通过时应直达 finish 并 commit')
    const gs = engine.getGraphState()!
    assert.equal(gs.nodes.repair.status, 'pending', 'repair 不应被执行')
  })

  test('检查有问题 -> repair -> 复检通过 -> finish', async () => {
    let committed = false
    // check 第一次有问题(issueCount=1)，修复后复检通过(issueCount=0)
    const engine = createLoop({
      definition: checkFlow(),
      resume: emptyResume,
      executors: {
        check: stubExecutor([
          { kind: 'done', output: { issueCount: 1 } },  // 第一次：有问题
          { kind: 'done', output: { issueCount: 0 } }   // 复检：通过
        ]),
        repair: stubExecutor([{ kind: 'done', output: { fixed: true } }]),
        finish: noopExecutor
      },
      onCommit: async () => { committed = true }
    })
    await engine.handleEvent({ kind: 'start', initialNode: 'check' })
    assert.ok(committed, '修复后复检通过应 commit')
    const gs = engine.getGraphState()!
    assert.equal(gs.nodes.repair.status, 'done', 'repair 应执行过')
  })
})

describe('挂起与恢复', () => {
  test('suspend -> suspended 态 -> resume 继续', async () => {
    let committed = false
    const engine = createLoop({
      definition: {
        nodes: [{ id: 'ask', name: '提问' }, { id: 'work', name: '干活' }],
        edges: [{ from: 'ask', to: 'work' }]
      },
      resume: { resume: { need_answer: { node: 'ask' } } },
      executors: {
        ask: stubExecutor([
          { kind: 'suspend', reason: 'need_answer' },  // 第一次：挂起等回答
          { kind: 'done', output: { answered: true } }  // 恢复后：完成
        ]),
        work: noopExecutor
      },
      onCommit: async () => { committed = true }
    })

    await engine.handleEvent({ kind: 'start', initialNode: 'ask' })
    assert.equal(engine.getState(), 'suspended', '应挂起')
    const gs1 = engine.getGraphState()!
    assert.equal(gs1.awaiting, 'need_answer')

    await engine.handleEvent({ kind: 'resume' })
    assert.equal(engine.getState(), 'idle', '恢复后应完成')
    assert.ok(committed, '恢复后应 commit')
    const gs2 = engine.getGraphState()!
    assert.equal(gs2.awaiting, null, '恢复后 awaiting 应清空')
  })

  test('JSON 检查点跨引擎恢复并保留挂起节点产出', async () => {
    const definition: FlowDefinition = {
      nodes: [{ id: 'ask', name: '提问' }, { id: 'work', name: '干活' }],
      edges: [{ from: 'ask', to: 'work' }]
    }
    const first = createLoop({
      flowId: 'requirement-flow',
      flowVersion: 2,
      definition,
      resume: { resume: { clarification: { node: 'ask' } } },
      executors: {
        ask: stubExecutor([{ kind: 'suspend', reason: 'clarification', output: { topic: 'scope' }, refs: { contract: 'contract-1' } }]),
        work: noopExecutor
      }
    })
    await first.handleEvent({ kind: 'start', initialNode: 'ask' })
    const checkpoint = first.getCheckpoint()
    assert.ok(checkpoint)
    assert.equal(checkpoint!.nodes.ask.output?.topic, 'scope')
    assert.equal(checkpoint!.nodes.ask.refs?.contract, 'contract-1')
    assert.equal('definition' in checkpoint!, false, '检查点不能序列化 guard 函数或流程定义')
    const persisted = JSON.parse(JSON.stringify(checkpoint))

    let committed = false
    const restored = createLoop({
      flowId: 'requirement-flow',
      flowVersion: 2,
      definition,
      resume: { resume: { clarification: { node: 'ask' } } },
      executors: {
        ask: stubExecutor([{ kind: 'done', output: { answered: true } }]),
        work: noopExecutor
      },
      onCommit: async () => { committed = true }
    })
    await restored.handleEvent({ kind: 'restore-checkpoint', checkpoint: persisted })
    assert.equal(restored.getState(), 'suspended')
    await restored.handleEvent({ kind: 'resume' })
    assert.equal(restored.getState(), 'idle')
    assert.ok(committed)
  })

  test('拒绝恢复其他流程版本的检查点', async () => {
    const engine = createLoop({
      flowId: 'current-flow', flowVersion: 3,
      definition: { nodes: [{ id: 'a', name: 'A' }], edges: [] },
      resume: emptyResume,
      executors: { a: noopExecutor }
    })
    await assert.rejects(
      engine.handleEvent({
        kind: 'restore-checkpoint',
        checkpoint: {
          flowId: 'old-flow', flowVersion: 1,
          nodes: { a: { status: 'pending' } }, current: 'a', awaiting: null
        }
      }),
      /检查点流程版本不匹配|checkpoint 流程版本不匹配/
    )
  })

  test('拒绝恢复被篡改的节点状态', async () => {
    const engine = createLoop({
      flowId: 'safe-flow', flowVersion: 1,
      definition: { nodes: [{ id: 'a', name: 'A' }], edges: [] },
      resume: emptyResume,
      executors: { a: noopExecutor }
    })
    await assert.rejects(
      engine.handleEvent({
        kind: 'restore-checkpoint',
        checkpoint: {
          flowId: 'safe-flow', flowVersion: 1,
          nodes: { a: { status: 'executing' as never } }, current: 'a', awaiting: null
        }
      }),
      /节点状态不合法/
    )
  })
})

describe('失败处理', () => {
  test('节点 failed -> blocked 态', async () => {
    const engine = createLoop({
      definition: linearFlow(),
      resume: emptyResume,
      executors: {
        a: stubExecutor([{ kind: 'failed', error: new Error('出错了') }]),
        b: noopExecutor
      },
      onCommit: async () => {}
    })
    await engine.handleEvent({ kind: 'start', initialNode: 'a' })
    assert.equal(engine.getState(), 'blocked')
    const gs = engine.getGraphState()!
    assert.equal(gs.nodes.a.status, 'failed')
    assert.equal(gs.nodes.b.status, 'pending', 'b 不应执行')
  })
})

describe('restore 载入历史快照', () => {
  test('restore 一个挂起态快照 -> suspended', async () => {
    const engine = createLoop({
      definition: {
        nodes: [{ id: 'x', name: 'X' }],
        edges: []
      },
      resume: { resume: { waiting: { node: 'x' } } },
      executors: { x: noopExecutor },
      onCommit: async () => {}
    })
    const snapshot: GraphState = {
      definition: {
        nodes: [{ id: 'x', name: 'X' }],
        edges: []
      },
      nodes: { x: { status: 'done', output: { prev: true } } },
      current: 'x',
      awaiting: 'waiting'
    }
    await engine.handleEvent({ kind: 'restore', graphState: snapshot })
    assert.equal(engine.getState(), 'suspended')
    const gs = engine.getGraphState()!
    assert.equal(gs.nodes.x.output?.prev, true, '快照内容应被载入')
  })

  test('restore 一个运行态快照 -> 继续推进', async () => {
    let committed = false
    const engine = createLoop({
      definition: {
        nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        edges: [{ from: 'a', to: 'b' }]
      },
      resume: emptyResume,
      executors: { a: noopExecutor, b: noopExecutor },
      onCommit: async () => { committed = true }
    })
    // 载入一个 a 已完成、current=b 的快照，引擎应从 b 继续
    const snapshot: GraphState = {
      definition: {
        nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        edges: [{ from: 'a', to: 'b' }]
      },
      nodes: { a: { status: 'done' }, b: { status: 'pending' } },
      current: 'b',
      awaiting: null
    }
    await engine.handleEvent({ kind: 'restore', graphState: snapshot })
    assert.equal(engine.getState(), 'idle', 'b 执行完应 commit')
    assert.ok(committed)
  })
})

describe('getGraphState 深拷贝隔离', () => {
  test('外部修改快照不影响引擎内部', async () => {
    const engine = createLoop({
      definition: linearFlow(),
      resume: emptyResume,
      executors: { a: noopExecutor, b: noopExecutor },
      onCommit: async () => {}
    })
    await engine.handleEvent({ kind: 'start', initialNode: 'a' })
    const gs = engine.getGraphState()!
    // 篡改外部快照
    gs.nodes.a.output = { hacked: true }
    // 引擎内部不受影响
    const gs2 = engine.getGraphState()!
    assert.equal(gs2.nodes.a.output, undefined, '引擎内部不应被外部篡改影响')
  })
})

describe('createLoop 创建时校验', () => {
  test('edge 引用不存在的节点 -> 报错', () => {
    assert.throws(
      () => createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }],
          edges: [{ from: 'a', to: 'b' }]  // b 不存在
        },
        resume: emptyResume,
        executors: { a: noopExecutor }
      }),
      /to "b" 不在 nodes 里/
    )
  })

  test('guard 引用未定义 -> 报错', () => {
    assert.throws(
      () => createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
          edges: [{ from: 'a', to: 'b', guard: 'missing' }]  // guard 未定义
        },
        resume: emptyResume,
        executors: { a: noopExecutor, b: noopExecutor }
      }),
      /未定义的 guard "missing"/
    )
  })

  test('节点缺 executor -> 报错', () => {
    assert.throws(
      () => createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
          edges: [{ from: 'a', to: 'b' }]
        },
        resume: emptyResume,
        executors: { a: noopExecutor }  // 缺 b
      }),
      /节点 "b" 没有对应的 executor/
    )
  })

  test('resume 指向不存在的节点 -> 报错', () => {
    assert.throws(
      () => createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }],
          edges: []
        },
        resume: { resume: { tag1: { node: 'nonexistent' } } },
        executors: { a: noopExecutor }
      }),
      /resume 表的 "tag1" 指向了不存在的节点/
    )
  })

  test('自环边 -> 报错', () => {
    assert.throws(
      () => createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }],
          edges: [{ from: 'a', to: 'a' }]
        },
        resume: emptyResume,
        executors: { a: noopExecutor }
      }),
      /自环/
    )
  })

  test('合法配置 -> 不报错', () => {
    assert.doesNotThrow(() =>
      createLoop({
        definition: {
          nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
          edges: [{ from: 'a', to: 'b', guard: 'g' }],
          guards: { g: () => true }
        },
        resume: { resume: { t: { node: 'a' } } },
        executors: { a: noopExecutor, b: noopExecutor }
      })
    )
  })
})
