/**
 * 线协议类型 —— 原样引用 client 的唯一类型来源（铁律）。
 * 业务类型来自 client/src/types/index.ts，事件载荷来自 client/src/api/client.ts 的
 * ClientEventMap 与 WorkbenchSnapshot，两边字段名逐字段一致，禁止在这里改名字。
 * 全部 import type（仅编译期），运行时不依赖 client 代码。
 */
export type {
  AssistAction,
  AssistSession,
  Blocker,
  BlockerType,
  CardOption,
  ChatMessage,
  AgentMessage,
  ClarificationAnswer,
  ClarificationMessage,
  ClarificationQuestion,
  Dashboard,
  DashboardStatus,
  DataSourceProbeResult,
  Issue,
  IssueStatus,
  McpAuthType,
  McpDataSource,
  ModelSettings,
  PreviewResolution,
  PreviewState,
  ProbeResult,
  ProblemMessage,
  RiskLevel,
  RoleModelConfig,
  RunStatus,
  Stage,
  StageState,
  SystemMessage,
  UserMessage,
  Version
} from '../../client/src/types/index'

export type { ClientEventMap, WorkbenchSnapshot } from '../../client/src/api/client'
