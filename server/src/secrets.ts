import type {
  McpDataSource,
  ModelSettings,
  PublishConfig,
  RoleModelConfig
} from './wire'

export const MASKED_SECRET = '••••••••'

function maskRole(role: RoleModelConfig): RoleModelConfig {
  return { ...role, apiKey: role.apiKey ? MASKED_SECRET : '' }
}

export function maskSettings(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    apiKey: settings.apiKey ? MASKED_SECRET : '',
    planner: maskRole(settings.planner),
    coder: maskRole(settings.coder),
    vision: maskRole(settings.vision)
  }
}

function hydrateRole(next: RoleModelConfig, current: RoleModelConfig): RoleModelConfig {
  return {
    ...next,
    apiKey: next.apiKey === MASKED_SECRET ? current.apiKey : next.apiKey
  }
}

export function hydrateSettingsSecrets(next: ModelSettings, current: ModelSettings): ModelSettings {
  return {
    ...next,
    apiKey: next.apiKey === MASKED_SECRET ? current.apiKey : next.apiKey,
    planner: hydrateRole(next.planner, current.planner),
    coder: hydrateRole(next.coder, current.coder),
    vision: hydrateRole(next.vision, current.vision)
  }
}

export function maskDataSources(sources: McpDataSource[]): McpDataSource[] {
  return sources.map(source => ({
    ...source,
    token: source.token ? MASKED_SECRET : ''
  }))
}

export function hydrateDataSourceSecrets(
  sources: McpDataSource[],
  current: McpDataSource[]
): McpDataSource[] {
  const byId = new Map(current.map(source => [source.id, source]))
  return sources.map(source => ({
    ...source,
    token: source.token === MASKED_SECRET ? (byId.get(source.id)?.token ?? '') : source.token
  }))
}

export function maskPublishConfig(config: PublishConfig): PublishConfig {
  return {
    ...config,
    accessKey: config.accessKey ? MASKED_SECRET : '',
    secretKey: config.secretKey ? MASKED_SECRET : ''
  }
}

export function hydratePublishConfigSecrets(
  next: PublishConfig,
  current: PublishConfig
): PublishConfig {
  return {
    ...next,
    accessKey: next.accessKey === MASKED_SECRET ? current.accessKey : next.accessKey,
    secretKey: next.secretKey === MASKED_SECRET ? current.secretKey : next.secretKey
  }
}
