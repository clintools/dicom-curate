import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCasesFromJson, type PublicCaseRecord } from 'dicom-synth'

/**
 * dicom-curate-local public case with per-case skip flags:
 * - `dciodvfy_skip` — dciodvfy cannot process the file; fetch/metadata only.
 * - `curate_skip` — `curateOne` (dcmjs) rejects the file; dciodvfy drift only.
 */
export type ConformancePublicCase = PublicCaseRecord & {
  curate_skip?: boolean
}

const publicCasesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'public-cases.json',
)

export function loadPublicCases(): ConformancePublicCase[] {
  return loadCasesFromJson(publicCasesPath) as ConformancePublicCase[]
}
