/**
 * Optional public fixture (pydicom-CT-small). Catalog test always runs;
 * fetch + dciodvfy tests require RUN_PUBLIC_CONFORMANCE=1 and network.
 *
 * See README.md — "dciodvfy.public.test.ts" and baselines/public/.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCaseById,
} from 'dicom-synth'
import { describe, expect, it } from 'vitest'
import {
  baselineDrift,
  baselineViolationSet,
  noViolationsIntroducedVsBaseline,
} from './baseline'
import { runDciodvfy } from './dciodvfy'
import {
  publicBaselinePath,
  resolveConformanceBin,
  runPassthroughCurate,
} from './helpers'

const catalogPath = defaultPublicCasesPath()
const publicCaseId = 'pydicom-CT-small'
const baselinePath = publicBaselinePath(publicCaseId)

const runPublic =
  !!process.env.RUN_PUBLIC_CONFORMANCE &&
  !!resolveConformanceBin() &&
  existsSync(baselinePath)

describe('dciodvfy public fixtures', () => {
  const bin = resolveConformanceBin()

  it.skipIf(!bin)('loads public case catalog metadata', () => {
    const rec = loadCaseById(catalogPath, publicCaseId)
    expect(rec.sha256).toHaveLength(64)
    expect(rec.source.kind).toBe('url')
  })

  it.skipIf(!runPublic)(
    'pydicom-CT-small: fetch, baseline drift, passthrough curate subset',
    async () => {
      const baseline = baselineViolationSet(baselinePath)
      const record = loadCaseById(catalogPath, publicCaseId)
      const cacheRoot = join(tmpdir(), `dc-public-${process.pid}`)
      const sourcePath = await fetchPublicCaseToCache(record, cacheRoot)

      const before = runDciodvfy(sourcePath, bin!)
      const drift = baselineDrift(baseline, before)
      expect(
        drift.ok,
        [
          drift.extra.length
            ? `extra vs baseline:\n${drift.extra.join('\n')}`
            : '',
          drift.missing.length
            ? `missing vs baseline:\n${drift.missing.join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ).toBe(true)

      const outDir = await mkdtemp(join(tmpdir(), 'dc-public-curate-'))
      const curated = await runPassthroughCurate(sourcePath, outDir)
      const after = runDciodvfy(curated, bin!)
      const { ok, introduced } = noViolationsIntroducedVsBaseline(
        baseline,
        after,
      )
      expect(ok, introduced.join('\n')).toBe(true)

      await rm(outDir, { recursive: true, force: true })
      await rm(cacheRoot, { recursive: true, force: true }).catch(() => {})
    },
    120_000,
  )
})
