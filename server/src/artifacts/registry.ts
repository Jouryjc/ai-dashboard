import type { ArtifactKind } from '../wire'
import { dashboardArtifactAdapter } from './dashboard/adapter'
import { businessAppArtifactAdapter } from './business-app/adapter'
import type { ArtifactAdapter } from './types'

export class ArtifactRegistry {
  private readonly adapters = new Map<ArtifactKind, ArtifactAdapter>()

  constructor(adapters: ArtifactAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new Error(`产物适配器重复注册：${adapter.kind}`)
      }
      this.adapters.set(adapter.kind, adapter)
    }
  }

  get(kind: ArtifactKind): ArtifactAdapter {
    const adapter = this.adapters.get(kind)
    if (!adapter) throw new Error(`尚未支持这种产物：${kind}`)
    return adapter
  }

  has(kind: ArtifactKind): boolean {
    return this.adapters.has(kind)
  }

  list(): ArtifactAdapter[] {
    return [...this.adapters.values()]
  }
}

export const artifactRegistry = new ArtifactRegistry([
  dashboardArtifactAdapter,
  businessAppArtifactAdapter
])
