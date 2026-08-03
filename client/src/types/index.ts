/**
 * 领域类型总入口 —— 全客户端唯一的类型来源（铁律 4）。
 * 所有字段注释用中文；界面文案只允许四种状态徽标：生成中 / 已完成 / 已发布 / 需要处理。
 * 其他模块一律从这里 import，不要自己复制类型定义。
 */

/* ==================== 项目与产物 ==================== */

/** 当前支持的产物类型；后续新增类型必须通过 Artifact Adapter 接入。 */
export type ArtifactKind = 'dashboard' | 'idux-page'

/** 产物构建目标；生成、校验、预览和导出都以它为准。 */
export interface TargetProfile {
  framework: 'static-html' | 'vue3'
  uiLibrary: 'none' | 'idux'
  uiLibraryVersion: string | null
  viewportProfiles: string[]
}

/** 项目状态：对应首页卡片的四种大白话徽标 */
export type ProjectStatus =
  | 'generating'      // 生成中
  | 'completed'       // 已完成
  | 'published'       // 已发布
  | 'needs_attention' // 需要处理（卡点/失败/升级的聚合态）

/** 旧名称兼容层；新代码使用 ProjectStatus。 */
export type DashboardStatus = ProjectStatus

/** 状态徽标文案（UI 直接查表，禁止另写映射） */
export const DASHBOARD_STATUS_LABEL: Record<ProjectStatus, string> = {
  generating: '生成中',
  completed: '已完成',
  published: '已发布',
  needs_attention: '需要处理'
}

/** 一个生成项目；大屏与 IDux 普通页面共享同一套会话、版本和审批基础设施。 */
export interface Project {
  /** 项目 ID */
  id: string
  /** 项目名称（顶栏点击可改名） */
  name: string
  /** 创建后锁定的产物类型；跨类型转换必须显式另存。 */
  artifactKind: ArtifactKind
  /** 构建目标与依赖版本。 */
  targetProfile: TargetProfile
  /** 大白话状态徽标 */
  status: ProjectStatus
  /** 封面截图地址（最近一次构建的缩略图，public/covers/ 下的相对路径） */
  coverUrl: string
  /** 当前版本号标签，如 "v3"；还没有任何版本时为 null */
  currentVersionLabel: string | null
  /** 当前版本 ID；旧数据迁移时从 isCurrent 版本恢复。 */
  currentRevisionId: string | null
  /** 最近修改时间（毫秒时间戳） */
  updatedAt: number
}

/** 旧名称兼容层；现有客户端组件逐步迁移到 Project。 */
export type Dashboard = Project

/* ==================== 版本（版本时间线节点） ==================== */

/**
 * 单条取数明细：记录这个版本生成时，从哪个数据源、用哪个工具、取了什么、结果如何。
 * 由 fetchDataForCreate 捕获，commitVersion 时随版本落盘（previews/<dashId>/<verId>/data-used.json）
 * 并塞进 Version.dataSourcesUsed，供版本抽屉展示「数据来源」。
 */
export interface DataUseEntry {
  /** 数据源名称（McpDataSource.name） */
  source: string
  /** 工具名（白名单校验过的真实工具，如 query_metric） */
  tool: string
  /** 取数规划 LLM 给的大白话用途（可能为空） */
  purpose: string
  /** 归一后的数据结构类型，复用 normalizeToolResult 的判定 */
  kind: 'metric' | 'records' | 'topology' | 'catalog' | 'raw'
  /** 取到的行数（metric/records=rows.length；topology=各层节点总和；catalog=清单项数；raw=0） */
  rows: number
  /** 结果状态：ok=正常取到 / fallback_raw=形状异常降级原文 / failed=取数抛异常 */
  status: 'ok' | 'fallback_raw' | 'failed'
  /** 失败时的错误摘要（status=failed 才有） */
  error?: string
}

/** 版本内文件清单与导出格式。 */
export interface ArtifactManifest {
  schemaVersion: 1
  kind: ArtifactKind
  entryFile: string
  files: string[]
  exportFormat: 'html' | 'zip'
}

export interface ValidationGateResult {
  id: string
  title: string
  status: 'passed' | 'failed' | 'skipped'
  detail: string | null
}

export interface ValidationReport {
  status: 'passed' | 'failed' | 'pending'
  gates: ValidationGateResult[]
}

/** 一个修订节点：回退 = 生成新节点，历史永不删除（UX §5.3） */
export interface Revision {
  /** 版本 ID */
  id: string
  /** 展示用版本号，如 "v3" */
  label: string
  /** 一句话变更摘要，如 "放大 CPU 图" */
  summary: string
  /** 生成时间（毫秒时间戳） */
  createdAt: number
  /** 该版本的缩略截图地址（hover 预览用） */
  screenshotUrl: string
  /** 是否为已发布版本（打 ★ 标） */
  published: boolean
  /** 是否为当前正在查看/使用的版本 */
  isCurrent: boolean
  /** 发布后的公网访问地址（如 http://59.37.133.154:20012）；未发布时为 undefined */
  publicUrl?: string
  /** 本版本生成时用到的数据源明细（演示数据/无数据源时为 undefined） */
  dataSourcesUsed?: DataUseEntry[]
  /** 该修订对应的产物清单。 */
  manifest: ArtifactManifest
  /** 准确性、体验性和安全性门禁结果。 */
  validationReport: ValidationReport
}

/** 旧名称兼容层；新代码使用 Revision。 */
export type Version = Revision

/* ==================== 运行状态（工作台全局状态机，UX §7.1） ==================== */

/** 工作台运行状态 */
export type RunStatus =
  | 'idle'                    // 空闲（待输入）
  | 'generating'              // 生成中（消息可排队）
  | 'awaiting_clarification'  // 等待澄清
  | 'blocked'                 // 卡点（外部阻塞 / 升级 / 失败 / 超时）
  | 'assisting'               // 人工协助中

/** 运行状态大白话（右栏窄条、顶栏一句话提示用） */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  idle: '空闲，等你提需求',
  generating: '正在生成',
  awaiting_clarification: '需要你补充一点信息',
  blocked: '遇到问题，需要处理',
  assisting: '支持人员正在协助'
}

/* ==================== 执行过程（右栏面板） ==================== */

/** 阶段节点状态：✓ 已完成 / ● 进行中 / ○ 未开始 / ✕ 已失败 */
export type StageState = 'done' | 'active' | 'pending' | 'failed'

/** 阶段时间线上的一个节点（新建 6~8 步，增量修改收敛为 3 步） */
export interface Stage {
  /** 阶段 ID */
  id: string
  /** 大白话阶段名，如 "理解需求"、"修复问题（2/3）" */
  title: string
  /** ✓ / ● / ○ */
  state: StageState
  /** 开始时间（毫秒，● 进行中用于显示耗时） */
  startedAt: number | null
  /** 完成时间（毫秒） */
  finishedAt: number | null
  /** 进行中的实时进展（"正在编写页面…已生成 2,340 字"），完成/未开始时为 null */
  detail?: string | null
}

/** Issue（问题）状态 */
export type IssueStatus =
  | 'fixing'  // 正在自动修复
  | 'fixed'   // 已修好（可展开看修复前后对比截图）
  | 'failed'  // 没修好（触发问题处理卡片）

/** 一个被自动检查发现的问题（Issue Ledger 的产品化） */
export interface Issue {
  /** 问题 ID */
  id: string
  /** 所属阶段 ID */
  stageId: string
  /** 问题一句话，如 "表格超出边界" */
  title: string
  /** 当前是第几次尝试（从 1 开始） */
  attempt: number
  /** 状态 */
  status: IssueStatus
  /** 修复前截图地址（多模态模式） */
  beforeShotUrl: string | null
  /** 修复后截图地址（status 为 fixed 时有值） */
  afterShotUrl: string | null
  /** 用户态修复细节说明（大白话；"开发者视图"不收在这里） */
  detail: string
}

/* ==================== 执行轨迹（右栏阶段节点下的实时动作流） ==================== */

/** 一个具体动作的状态：● 进行中 / ✓ 完成 / ✕ 失败 */
export type StepState = 'active' | 'done' | 'failed'

/**
 * Agent 做的一件具体事（观测性设计 §2.3 执行轨迹的用户态投影）。
 * 挂在某个阶段节点下，多个动作按时间排列就是"Agent 具体干了哪些事"。
 * 文案在产生的一侧（服务端/mock）写入时就固化成大白话，前端只渲染不翻译。
 */
export interface AgentStep {
  /** 动作 ID */
  id: string
  /** 所属阶段 ID（挂在哪个阶段节点下） */
  stageId: string
  /** 一句话动作，如 "精读参考图：裁出 5 块局部放大" */
  title: string
  /** 结果摘要（完成/失败时补充，如 "认出了 3 个面板、2 个指标"）；没有 = null */
  detail: string | null
  /** 状态 */
  state: StepState
  /** 开始时间（毫秒） */
  startedAt: number
  /** 结束时间（毫秒；进行中 = null） */
  finishedAt: number | null
}

/* ==================== 选项卡（澄清卡片 / 问题处理卡片共用） ==================== */

/** 风险等级：决定推荐理由与是否允许倒计时自动执行（UX §4.3 / C11） */
export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * 卡片上的一个选项。
 * 规范（UX §4.3）：每次 1~3 个选项；恰好一个 recommended=true 并附推荐理由；
 * 每个选项必须写清"选了之后会发生什么"。
 */
export interface CardOption {
  /** 选项 ID（chooseOption 回传用） */
  id: string
  /** 选项标题，如 "呼叫人工协助" */
  title: string
  /** 后果说明（大白话）：选了会发生什么、代价是什么 */
  consequence: string
  /** 是否推荐选项（★ 推荐，一张卡片恰好一个） */
  recommended: boolean
  /** 推荐理由（规则表确定性生成，如 "同类问题自动修复成功率 90%+"） */
  recommendReason: string | null
  /** 风险等级 */
  riskLevel: RiskLevel
  /**
   * 倒计时自动执行的截止毫秒时间戳（仅低风险"重试"类）；
   * null 表示不自动执行。回退/发布/权限类永远为 null。
   */
  autoExecuteAt: number | null
}

/* ==================== 对话消息（五型，UX §4.2） ==================== */

/** 澄清卡片里的一个问题 */
export interface ClarificationQuestion {
  /** 问题 ID */
  id: string
  /** 问题文本，如 "监控哪些指标？" */
  question: string
  /** 可点选项（含 ★推荐 标注；用户也可以自己打字） */
  options: CardOption[]
  /** 是否允许自定义输入 */
  allowCustomInput: boolean
  /** 用户已给出的回答（选项标题或自定义文本）；未答为 null */
  answer: string | null
}

/** 消息公共字段 */
interface MessageBase {
  /** 消息 ID */
  id: string
  /** 发送时间（毫秒时间戳） */
  createdAt: number
}

/** 1. 用户消息（右气泡） */
export interface UserMessage extends MessageBase {
  kind: 'user'
  /** 消息文本 */
  text: string
  /** 附件地址列表（图片/参考稿，仅多模态模式可用） */
  attachmentUrls: string[]
  /** 生成中追加的排队消息：true 时界面提示"已收到，将在当前步骤后处理" */
  queued: boolean
}

/** 2. Agent 消息（左气泡，大白话） */
export interface AgentMessage extends MessageBase {
  kind: 'agent'
  /** 消息文本 */
  text: string
}

/** 3. 澄清卡片（结构化问答，一次最多 3 个问题） */
export interface ClarificationMessage extends MessageBase {
  kind: 'clarification'
  /** 卡片引导语，如 "开始之前，想跟你确认几件事" */
  intro: string
  /** 问题列表（≤3） */
  questions: ClarificationQuestion[]
  /** 是否已全部回答（回答后流程自动继续） */
  answered: boolean
}

/** 4. 问题处理卡片（必选项 + 必推荐，UX §4.3） */
export interface ProblemMessage extends MessageBase {
  kind: 'problem'
  /** 卡片标题，如 "自动修复没有成功" */
  title: string
  /** 问题描述一句话：发生了什么、影响到什么 */
  description: string
  /** 选项列表（1~3 个，恰好一个 ★推荐） */
  options: CardOption[]
  /** 用户已选择的选项 ID；未选为 null。选择后卡片折叠为系统操作条 */
  chosenOptionId: string | null
  /** 关联的 Issue ID（可与右栏 Issue 卡片联动） */
  relatedIssueId: string | null
}

/** 5. 系统操作条（轻量灰条："已回退到 v2 版本"、"你选择了：呼叫人工协助"） */
export interface SystemMessage extends MessageBase {
  kind: 'system'
  /** 条内文本 */
  text: string
}

/** 对话消息五型联合 */
export type ChatMessage =
  | UserMessage
  | AgentMessage
  | ClarificationMessage
  | ProblemMessage
  | SystemMessage

/* ==================== 卡点（右栏行动区，UX §5.4） ==================== */

/** 卡点类型（与 UX §5.4 表一一对应） */
export type BlockerType =
  | 'clarification'  // 等待澄清："需要你补充一点信息" + [去回答]
  | 'external'       // 外部阻塞（如数据源不可用）
  | 'escalated'      // 修复超预算升级："这个问题需要人工处理"
  | 'failed'         // 失败：[重试一次] [回退到上个版本] [呼叫人工]
  | 'stall'          // 停留超时："比预期久了一点，仍在处理"

/**
 * 当前卡点。对话区问题处理卡片与右栏卡点行动区共享同一事件源：
 * 两处渲染同一个 Blocker.options，点击等效，状态永远一致。
 */
export interface Blocker {
  /** 卡点 ID */
  id: string
  /** 卡点类型 */
  type: BlockerType
  /** 大白话标题，如 "需要你补充一点信息" */
  title: string
  /** 大白话原因说明 */
  description: string
  /** 行动选项（1~3 个，恰好一个 ★推荐；与对话卡片同一组） */
  options: CardOption[]
  /** 关联的对话消息 ID（"去回答"点击后滚动定位用） */
  relatedMessageId: string | null
}

/* ==================== 预览区 ==================== */

/** 预览逻辑分辨率：大屏支持 1920/2560，IDux 页面支持 1920/1366。 */
export type PreviewResolution = '1920x1080' | '2560x1440' | '1366x768'

/** 预览区状态（UX §4.2 中区） */
export type PreviewState =
  | 'empty'     // 无任何版本：显示占位引导 "在左侧描述你想要的大屏"
  | 'building'  // 构建中：显示上一版 + 半透明遮罩 "正在生成新版本…"
  | 'ready'     // 就绪：新版本淡入

/* ==================== 人工协助（F5） ==================== */

/** 客服的一条代办动作（实时推送给用户，透明原则） */
export interface AssistAction {
  /** 动作时间（毫秒） */
  at: number
  /** 大白话描述，如 "小李 帮你重试了「表格超出边界」✓" */
  text: string
}

/** 人工协助会话 */
export interface AssistSession {
  /** 支持人员称呼，如 "小李" */
  operatorName: string
  /** 协助开始时间（毫秒） */
  startedAt: number
  /** 代办动作流水（最新在后） */
  actions: AssistAction[]
}

/* ==================== 设置中心 ==================== */

/** 高级：单个角色（规划/编码/视觉）的独立配置；字段留空 = 跟随上面的主设置 */
export interface RoleModelConfig {
  /** 模型名（空 = 跟随主模型） */
  model: string
  /** API 地址（空 = 跟随主地址） */
  apiBase: string
  /** API Key（空 = 跟随主 Key） */
  apiKey: string
}

/** 模型设置（小白只需填 4 个字段：服务商/地址/Key/模型） */
export interface ModelSettings {
  /** 服务商预设名，如 "公司内置" */
  provider: string
  /** API 地址 */
  apiBase: string
  /** API Key（界面默认打码显示） */
  apiKey: string
  /** 模型名，如 "qwen2.5-72b-instruct" */
  model: string
  /** 高级：规划角色独立配置（三项全空 = 完全跟随主设置） */
  planner: RoleModelConfig
  /** 高级：编码角色独立配置 */
  coder: RoleModelConfig
  /** 高级：视觉角色独立配置 */
  vision: RoleModelConfig
}

/** 「测试连接」结果（/probe，反馈用大白话，UX §6） */
export interface ProbeResult {
  /** 是否连得上 */
  ok: boolean
  /** 是否支持图片理解（多模态）；不支持时 📎 置灰 */
  supportsVision: boolean
  /** 大白话结论，如 "连接成功，支持图片理解，所有功能可用" */
  message: string
  /** 错误细节（收在「查看详情」里，不直接给小白看） */
  detail: string | null
}

/** MCP 数据源的认证方式 */
export type McpAuthType =
  /** 不用认证 */
  | 'none'
  /** Bearer Token（请求自动带上 Authorization: Bearer <令牌>） */
  | 'bearer'
  /** 自定义请求头（用户自己填请求头名和值，如 X-Api-Key） */
  | 'header'
  /** AK/SK + HMAC 签名（每请求按 METHOD\nPATH\nTIMESTAMP\nBODY 算 HMAC-SHA256，带 X-AK/X-Timestamp/X-Signature 三个头） */
  | 'hmac'

/** 一个 MCP 数据源（生成大屏时从它取真实数据，数据在生成期烤进 HTML） */
export interface McpDataSource {
  /** 唯一 ID */
  id: string
  /** 大白话名称，如 "生产数据库" */
  name: string
  /** 服务地址 */
  url: string
  /** 认证方式 */
  authType: McpAuthType
  /** 令牌或请求头的值：bearer 时为令牌，header 时为请求头的值，none 时为空串 */
  token: string
  /** 自定义请求头名（仅 authType='header' 时用，如 "X-Api-Key"） */
  headerName: string
  /** 访问密钥 ID（仅 authType='hmac' 时用，作为 X-AK 头的值） */
  accessKey: string
  /** 访问密钥 Secret（仅 authType='hmac' 时用，用于算 HMAC-SHA256 签名，不随请求发送） */
  secretKey: string
  /** 是否启用（关掉后生成大屏时不从这个源取数） */
  enabled: boolean
}

/** 「测试数据源连接」结果（反馈用大白话，同 ProbeResult 风格） */
export interface DataSourceProbeResult {
  /** 是否连得上 */
  ok: boolean
  /** 连上后发现的工具名列表（生成大屏时能用哪些取数工具） */
  tools: string[]
  /** 大白话结论，如 "连接成功，发现 3 个可用工具" */
  message: string
  /** 错误细节（收在「查看详情」里，不直接给小白看） */
  detail: string | null
}

/**
 * 发布配置（生成好的大屏要发布到哪个云上，需要先在这里填好云的接入信息）。
 * 三个字段：endpoint 访问地址 / accessKey 访问密钥 ID / secretKey 访问密钥（界面默认打码）。
 */
export interface PublishConfig {
  /** 对象存储 / 云服务的访问地址，如 "https://oss-cn-hangzhou.aliyuncs.com" */
  endpoint: string
  /** 访问密钥 ID（Access Key ID） */
  accessKey: string
  /** 访问密钥（Secret Access Key，界面默认打码显示） */
  secretKey: string
}

/** 发布进度阶段（驱动发布弹窗的视图切换） */
export type PublishPhase =
  | 'idle'       // 未发布（确认页）
  | 'uploading'  // 准备云环境 + 上传大屏
  | 'serving'    // 起服务 + 暴露公网
  | 'success'    // 发布成功
  | 'failed'     // 发布失败

/** 发布进度事件（publishProgress，发布弹窗独占订阅，不进对话区/右栏） */
export interface PublishProgress {
  /** 大屏 ID */
  dashboardId: string
  /** 当前阶段 */
  phase: PublishPhase
  /** 大白话进度文本，如 "正在把大屏上传到云端…" */
  message: string
  /** 成功时的公网访问地址（phase='success' 才有） */
  publicUrl?: string
  /** 失败原因（phase='failed' 才有） */
  error?: string
}

/* ==================== 其它 ==================== */

/** 回答澄清卡片时回传的答案 */
export interface ClarificationAnswer {
  /** 问题 ID */
  questionId: string
  /** 选中的选项 ID，或自定义输入时为空串 */
  optionId: string
  /** 自定义输入文本（点选项时为空串） */
  customText: string
}

/* ==================== LoopEngine 流程图快照（调试面板用） ==================== */

/** 节点状态（引擎态，与 StageState 业务态不同：含 failed/skipped） */
export type GraphNodeStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped'

/**
 * 节点快照（脱敏后）：summary 是从 output/refs 白名单提取的决策摘要，
 * 大字段（HTML/dataBlock/dataURL）已转成长度，前端展开只看关键字段值。
 */
export interface GraphNodeSnapshot {
  /** 节点 ID（planner/match/fetch/coder/check/repair/finish） */
  id: string
  /** 节点中文名（理解需求/匹配模板/…） */
  name: string
  /** 引擎态 */
  status: GraphNodeStatus
  /** 决策摘要：key=字段名，value=已脱敏的值（字符串/数字/布尔/null） */
  summary: Record<string, string | number | boolean | null>
}

/** 流程图的边（含 guard 名，前端可展示"为什么走这条边"） */
export interface GraphEdge {
  from: string
  to: string
  /** 守卫名（如 isPassed），无则无条件兜底 */
  guard?: string
}

/**
 * 流程图整体快照（可序列化，不含 guards 函数）。
 * 由服务端 adapter 在每个节点完成时摘取推送，调试面板渲染用。
 */
export interface GraphSnapshot {
  /** 全部节点（按定义顺序） */
  nodes: GraphNodeSnapshot[]
  /** 全部边（拓扑） */
  edges: GraphEdge[]
  /** 当前执行指针（高亮用） */
  current: string | null
  /** 挂起标记（非 null 时流程在等人/等恢复） */
  awaiting: string | null
}
