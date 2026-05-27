#!/usr/bin/env tsx
/**
 * Regenerate committed dciodvfy baselines (normalised violation sets).
 *
 *   DCIODVFY_PATH=/path/to/dciodvfy pnpm update:conformance-baselines
 *
 * Synthetic DICOM is generated via dicom-synth (not committed to this codebase).
 * Public-case baselines require network unless skipped (see below).
 *
 * Optional local fixtures (your machine only; not committed to dicom-curate):
 *   CONFORMANCE_LOCAL_PATH=/path/to/file.dcm:/path/to/fixtures \
 *   CONFORMANCE_LOCAL_BASELINE_DIR=/path/to/your-baselines \
 *   pnpm update:conformance-baselines
 *
 *   SKIP_PUBLIC_CONFORMANCE_BASELINES=1  — skip pydicom public fetch/write
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCaseById,
  SYNTHETIC_FIXTURES,
  writeSyntheticFixturesToDir,
} from 'dicom-synth'
import type { ConformanceBaseline } from '../conformance/baseline'
import { runDciodvfy, violationSet } from '../conformance/dciodvfy'
import { resolveLocalConformanceCases } from '../conformance/localFixtures'
import { resolveConformanceBin } from '../conformance/resolveBin'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const conformanceRoot = join(repoRoot, 'conformance')

function syntheticBaselinePath(fixtureId: string): string {
  return join(
    conformanceRoot,
    'baselines/synthetic',
    `${fixtureId}.dciodvfy-baseline.json`,
  )
}

function publicBaselinePath(caseId: string): string {
  return join(
    conformanceRoot,
    'baselines/public',
    `${caseId}.dciodvfy-baseline.json`,
  )
}

const syntheticDir = mkdtempSync(join(tmpdir(), 'dc-baseline-synth-'))
writeSyntheticFixturesToDir(syntheticDir)

const syntheticTargets = SYNTHETIC_FIXTURES.map(
  ({ filename }: (typeof SYNTHETIC_FIXTURES)[number]) => {
    const id = filename.replace(/\.dcm$/, '')
    return {
      label: filename,
      dicomPath: join(syntheticDir, filename),
      baselinePath: syntheticBaselinePath(id),
    }
  },
)

function writeBaseline(path: string, baseline: ConformanceBaseline) {
  mkdirSync(dirname(path), { recursive: true })
  const sorted = [...baseline.violations].sort()
  writeFileSync(
    path,
    `${JSON.stringify({ ...baseline, violations: sorted }, null, 2)}\n`,
  )
  console.log(`wrote ${path} (${sorted.length} violations)`)
}

async function main() {
  const bin = resolveConformanceBin()
  if (!bin) {
    console.error(
      'dciodvfy not found. Install dicom3tools or set DCIODVFY_PATH.',
    )
    process.exit(1)
  }

  for (const t of syntheticTargets) {
    const violations = [...violationSet(runDciodvfy(t.dicomPath, bin))].sort()
    writeBaseline(t.baselinePath, {
      label: t.label,
      violations,
      notes: 'Regenerate with pnpm update:conformance-baselines',
    })
  }

  if (!process.env.SKIP_PUBLIC_CONFORMANCE_BASELINES) {
    const publicCaseId = 'pydicom-CT-small'
    const catalogPath = defaultPublicCasesPath()
    const record = loadCaseById(catalogPath, publicCaseId)
    const cacheRoot = join(repoRoot, '.cache', 'conformance-baselines')
    const dicomPath = await fetchPublicCaseToCache(record, cacheRoot)
    const violations = [...violationSet(runDciodvfy(dicomPath, bin))].sort()
    writeBaseline(publicBaselinePath(publicCaseId), {
      label: publicCaseId,
      violations,
      notes: 'Regenerate with pnpm update:conformance-baselines',
    })
  } else {
    console.log(
      'skipped public baselines (SKIP_PUBLIC_CONFORMANCE_BASELINES=1)',
    )
  }

  const localRoots = process.env.CONFORMANCE_LOCAL_PATH?.trim()
  if (localRoots && !process.env.CONFORMANCE_LOCAL_BASELINE_DIR?.trim()) {
    console.error(
      'CONFORMANCE_LOCAL_PATH is set but CONFORMANCE_LOCAL_BASELINE_DIR is not.',
    )
    process.exit(1)
  }

  let localCases: ReturnType<typeof resolveLocalConformanceCases> = []
  try {
    localCases = resolveLocalConformanceCases()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }

  for (const c of localCases) {
    if (!c.baselinePath) continue
    const violations = [...violationSet(runDciodvfy(c.dicomPath, bin))].sort()
    writeBaseline(c.baselinePath, {
      label: c.id,
      violations,
      notes: 'Regenerate with pnpm update:conformance-baselines (local corpus)',
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
