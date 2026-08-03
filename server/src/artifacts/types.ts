import type {
  ArtifactKind,
  ArtifactManifest,
  TargetProfile,
  ValidationReport
} from '../wire'

export interface ArtifactDraft {
  files: Record<string, string>
  entryFile: string
}

export interface ArtifactAdapter {
  readonly kind: ArtifactKind
  createTargetProfile(): TargetProfile
  createManifest(draft?: ArtifactDraft): ArtifactManifest
  validateDraft(draft: ArtifactDraft): ValidationReport
  exportFileName(projectName: string, revisionLabel: string): string
}
