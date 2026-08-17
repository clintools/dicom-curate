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
 *   PRUNE_STALE_BASELINES=1              — delete synthetic baselines that no
 *                                          longer have a fixture (reported,
 *                                          not deleted, without this)
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchPublicCaseToCache } from 'dicom-synth'
import type { ConformanceBaseline } from '../conformance/baseline'
import { runDciodvfy, violationSet } from '../conformance/dciodvfy'
import {
  publicBaselinePath,
  syntheticBaselinesDir,
  writeSyntheticConformanceFixtures,
  writeSyntheticViolationFixtures,
} from '../conformance/helpers'
import { resolveLocalConformanceCases } from '../conformance/localFixtures'
import { loadPublicCases } from '../conformance/publicCases'
import { resolveConformanceBin } from '../conformance/resolveBin'

async function buildSyntheticTargets(
  syntheticDir: string,
  violationDir: string,
) {
  const cases = [
    ...(await writeSyntheticConformanceFixtures(syntheticDir)),
    ...(await writeSyntheticViolationFixtures(violationDir)),
  ]
  return cases.map((c) => ({
    label: `${c.id}.dcm`,
    dicomPath: c.dicomPath,
    baselinePath: c.baselinePath,
  }))
}

/**
 * A synthetic baseline with no matching fixture is stale (e.g. a violation
 * class dropped from dicom-synth's vocabulary) and nothing else would notice
 * it. Deleting is opt-in: the generated set is whatever the spec constants say
 * *right now*, and this script is bundled with esbuild rather than typechecked,
 * so a local experiment that trims VIOLATION_CLASSES reaches this loop without
 * tripping the exhaustiveness check in helpers.ts.
 */
function reportStaleSyntheticBaselines(currentPaths: string[]) {
  const current = new Set(currentPaths)
  const prune = !!process.env.PRUNE_STALE_BASELINES
  for (const name of readdirSync(syntheticBaselinesDir)) {
    if (!name.endsWith('.dciodvfy-baseline.json')) continue
    const path = join(syntheticBaselinesDir, name)
    if (current.has(path)) continue
    if (!prune) {
      console.warn(
        `stale ${path} (no matching synthetic fixture) — delete it with PRUNE_STALE_BASELINES=1`,
      )
      continue
    }
    rmSync(path)
    console.log(`pruned ${path} (no matching synthetic fixture)`)
  }
}

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

  const syntheticDir = mkdtempSync(join(tmpdir(), 'dc-baseline-synth-'))
  const violationDir = mkdtempSync(join(tmpdir(), 'dc-baseline-violations-'))
  try {
    const syntheticTargets = await buildSyntheticTargets(
      syntheticDir,
      violationDir,
    )

    for (const t of syntheticTargets) {
      const violations = [...violationSet(runDciodvfy(t.dicomPath, bin))].sort()
      writeBaseline(t.baselinePath, {
        label: t.label,
        violations,
        notes: 'Regenerate with pnpm update:conformance-baselines',
      })
    }

    reportStaleSyntheticBaselines(syntheticTargets.map((t) => t.baselinePath))
  } finally {
    rmSync(syntheticDir, { recursive: true, force: true })
    rmSync(violationDir, { recursive: true, force: true })
  }

  if (!process.env.SKIP_PUBLIC_CONFORMANCE_BASELINES) {
    for (const record of loadPublicCases()) {
      if (record.dciodvfy_skip) {
        console.log(`skipped ${record.id} (dciodvfy_skip)`)
        continue
      }
      // Default cache root — shared with the public conformance tests.
      const dicomPath = await fetchPublicCaseToCache(record)
      const violations = [...violationSet(runDciodvfy(dicomPath, bin))].sort()
      writeBaseline(publicBaselinePath(record.id), {
        label: record.id,
        violations,
        notes: 'Regenerate with pnpm update:conformance-baselines',
      })
    }
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
