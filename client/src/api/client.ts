/**
 * ClientApi —— 渲染进程与"后端"之间的唯一契约。
 * 当前实现是本地 mock（src/api/mock/engine.ts，由 mock-engine agent 填充剧情）；
 * 将来接真实 Orchestrator 时只需换 src/api/index.ts 的导出，stores 与 UI 零改动。
 *
 * 约定：
 * - 所有方法都是"发指令"，立即 resolve；结果通过事件推回来（on 订阅）。
 * - 事件载荷一律带 dashboardId，stores 按当前打开的大屏过滤。
 * - 文案一律大白话，由产生数据的一侧（mock/后端）准备好。
 */
import type {
  AssistSession,
  Blocker,
  ChatMessage,
  ClarificationAnswer,
  Dashboard,
  Issue,
  ModelSettings,
  PreviewResolution,
  ProbeResult,
  RunStatus,
  Stage,
  Version
} from '../types'

/** 事件载荷表：事件名 -> 载荷 */
export interface ClientEventMap {
  /** 对话区新增一条消息（Agent 回复 / 澄清卡片 / 问题处理卡片 / 系统操作条） */
  message: { dashboardId: string; message: ChatMessage }
  /** 既有消息内容被更新（选项已选、排队标记摘除等）；stores 按 id 原位替换 */
  messageUpdated: { dashboardId: string; message: ChatMessage }
  /** 阶段时间线节点状态变化（✓ 已完成 / ● 进行中 / ○ 未开始） */
  stage: { dashboardId: string; stage: Stage }
  /** 问题（Issue）状态变化：第几次尝试、修好/没修好 */
  issue: { dashboardId: string; issue: Issue }
  /** 卡点出现或解除（null = 解除）。问题卡片与右栏行动区共用此事件源 */
  blocker: { dashboardId: string; blocker: Blocker | null }
  /** 新版本预览就绪（预览淡入 + 桌面通知"你的大屏做好了"） */
  previewReady: { dashboardId: string; versionId: string; url: string }
  /** 首次创建中：页面正在逐步生成（部分 HTML 的实时预览地址，带防缓存参数） */
  previewBuilding: { dashboardId: string; url: string }
  /** 版本时间线新增节点（含回退产生的新节点） */
  versionAdded: { dashboardId: string; version: Version }
  /** 工作台运行状态变化（空闲/生成中/等待澄清/卡点/人工协助中） */
  runStatus: { dashboardId: string; status: RunStatus }
  /** 大屏卡片信息变化（状态徽标、封面、最近修改时间） */
  dashboardUpdated: { dashboard: Dashboard }
  /** 人工协助进展：客服的每个代办动作；null = 协助结束 */
  assist: { dashboardId: string; session: AssistSession | null }
}

/** 事件回调 */
export type ClientEventHandler<K extends keyof ClientEventMap> = (payload: ClientEventMap[K]) => void

/** 客户端 API 接口 */
export interface ClientApi {
  /* ---------- 首页：大屏列表 ---------- */
  /** 拉取全部大屏卡片 */
  listDashboards(): Promise<Dashboard[]>
  /** 新建大屏（进入工作台后用户在对话区描述需求） */
  createDashboard(name: string): Promise<Dashboard>
  /** 改名（顶栏标题点击改名） */
  renameDashboard(id: string, name: string): Promise<void>
  /** 删除大屏 */
  deleteDashboard(id: string): Promise<void>

  /* ---------- 工作台：打开/关闭 ---------- */
  /**
   * 进入工作台：返回一次性快照（消息、阶段、版本、运行状态等），
   * 之后通过事件增量更新。
   */
  enterDashboard(id: string): Promise<WorkbenchSnapshot>
  /** 离开工作台（停止该大屏的模拟推送） */
  leaveDashboard(id: string): Promise<void>

  /* ---------- 对话 ---------- */
  /** 发送消息；生成中发送 = 排队（UX §4.2，输入框永不锁定） */
  sendMessage(dashboardId: string, text: string, attachmentUrls?: string[]): Promise<void>
  /** 回答澄清卡片（点选项或自定义输入；回答后流程自动继续） */
  answerClarification(dashboardId: string, messageId: string, answers: ClarificationAnswer[]): Promise<void>
  /**
   * 选择问题处理卡片 / 右栏卡点行动区的选项（两处点击等效，同一事件源）。
   * 点选后卡片折叠为系统操作条，流程立即继续。
   */
  chooseOption(dashboardId: string, optionId: string): Promise<void>
  /** 中断低风险推荐的倒计时自动执行（问题卡片上的「先等等」；没有待定的自动执行时为空操作） */
  cancelAutoExec(dashboardId: string): Promise<void>

  /* ---------- 版本 ---------- */
  /** 版本时间线 */
  listVersions(dashboardId: string): Promise<Version[]>
  /** 预览历史版本（顶栏出现"正在查看历史版本"横幅） */
  previewVersion(dashboardId: string, versionId: string): Promise<void>
  /** 退出历史版本预览，回到当前版本 */
  backToCurrentVersion(dashboardId: string): Promise<void>
  /** 回退到某版本：二次确认后生成一个新节点（内容 = 目标版本），历史不删 */
  rollback(dashboardId: string, versionId: string): Promise<void>

  /* ---------- 预览 ---------- */
  /** 切换预览分辨率（仅缩放展示，基准恒为 1920×1080） */
  setPreviewResolution(dashboardId: string, resolution: PreviewResolution): Promise<void>

  /* ---------- 封面 / 导出 ---------- */
  /**
   * 上传大屏封面截图（Electron 离屏截取的 1920×1080 PNG dataURL，≤8MB）。
   * 服务端落盘后回推 dashboardUpdated 更新封面；mock 为空操作（封面仍用关键字示例图）。
   */
  uploadCover(dashboardId: string, imageDataUrl: string): Promise<void>
  /** 导出某版本完整 HTML 的下载地址（http：export 端点绝对地址；mock：该版本的预览地址） */
  exportVersionUrl(dashboardId: string, versionId: string): string

  /* ---------- 发布 ---------- */
  /** 发布 = 提交发布申请（非管理员走审批，F6） */
  publish(dashboardId: string): Promise<void>

  /* ---------- 人工协助（F5） ---------- */
  /** 呼叫人工协助（可选填一句话描述） */
  callAssist(dashboardId: string, note?: string): Promise<void>
  /** 结束协助，收回控制权 */
  endAssist(dashboardId: string): Promise<void>

  /* ---------- 设置 ---------- */
  /** 读取模型设置 */
  getSettings(): Promise<ModelSettings>
  /** 保存模型设置 */
  saveSettings(settings: ModelSettings): Promise<void>
  /** 测试连接（/probe，返回大白话结论） */
  testConnection(settings?: ModelSettings): Promise<ProbeResult>

  /* ---------- 事件订阅 ---------- */
  /**
   * 订阅事件，返回退订函数。
   * 用法：const off = api.on('message', p => { ... })，组件卸载时 off()。
   */
  on<K extends keyof ClientEventMap>(event: K, handler: ClientEventHandler<K>): () => void
}

/** enterDashboard 返回的一次性快照 */
export interface WorkbenchSnapshot {
  /** 大屏卡片信息 */
  dashboard: Dashboard
  /** 当前运行状态 */
  runStatus: RunStatus
  /** 对话消息（时间升序） */
  messages: ChatMessage[]
  /** 阶段时间线 */
  stages: Stage[]
  /** 问题列表 */
  issues: Issue[]
  /** 当前卡点（无卡点 = null） */
  blocker: Blocker | null
  /** 版本时间线（新的在前） */
  versions: Version[]
  /** 预览区状态与内容 */
  preview: {
    state: 'empty' | 'building' | 'ready'
    url: string | null
  }
  /** 人工协助会话（无 = null） */
  assistSession: AssistSession | null
}
