import { strToU8, zipSync } from 'fflate'
import type { ArtifactDraft } from '../types'

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024

export async function createBusinessAppSourceArchive(draft: ArtifactDraft): Promise<Buffer> {
  const files = Object.fromEntries(
    Object.keys(draft.files)
      .sort()
      .map(fileName => [fileName, strToU8(draft.files[fileName])])
  )
  const zipped = zipSync(files, { level: 9 })
  if (zipped.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('业务应用导出包超过 10MB 安全上限')
  }
  return Buffer.from(zipped)
}
