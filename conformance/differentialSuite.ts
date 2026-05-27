import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baselineDrift,
  baselineViolationSet,
  noViolationsIntroducedVsBaseline,
} from './baseline'
import {
  type DciodvfyViolation,
  isConformanceNonRegression,
  runDciodvfy,
} from './dciodvfy'
import { resolveConformanceBin, runPassthroughCurate } from './helpers'

export type DifferentialFixture = {
  id: string
  dicomPath: string
  baselinePath?: string
}

function assertPassthroughNonRegression(
  before: DciodvfyViolation[],
  after: DciodvfyViolation[],
  baseline?: Set<string>,
): { ok: boolean; introduced: string[] } {
  const vsBefore = isConformanceNonRegression(before, after)
  if (!baseline) return vsBefore
  const vsBaseline = noViolationsIntroducedVsBaseline(baseline, after)
  const introduced = [
    ...new Set([...vsBefore.introduced, ...vsBaseline.introduced]),
  ]
  return { ok: vsBefore.ok && vsBaseline.ok, introduced }
}

/** Register the four standard dciodvfy differential tests per fixture. */
export function registerDifferentialConformanceTests(
  fixtures: DifferentialFixture[],
  tempPrefix: string,
): void {
  const bin = resolveConformanceBin()

  for (const fixture of fixtures) {
    const hasBaseline =
      !!fixture.baselinePath && existsSync(fixture.baselinePath)

    describe(fixture.id, () => {
      it.skipIf(!bin || !hasBaseline)(
        'live before matches committed baseline (dciodvfy version drift)',
        () => {
          const baseline = baselineViolationSet(fixture.baselinePath!)
          const before = runDciodvfy(fixture.dicomPath, bin!)
          const drift = baselineDrift(baseline, before)
          expect(
            drift.ok,
            [
              drift.extra.length
                ? `extra:\n${drift.extra.slice(0, 5).join('\n')}`
                : '',
              drift.missing.length
                ? `missing:\n${drift.missing.slice(0, 5).join('\n')}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ).toBe(true)
        },
      )

      it.skipIf(!bin)('same file has empty introduced set', () => {
        const v = runDciodvfy(fixture.dicomPath, bin!)
        const { ok, introduced } = isConformanceNonRegression(v, v)
        expect(ok).toBe(true)
        expect(introduced).toEqual([])
      })

      it.skipIf(!bin)(
        'byte-identical copy introduces no new violations',
        async () => {
          const before = runDciodvfy(fixture.dicomPath, bin!)
          const dir = await mkdtemp(
            join(tmpdir(), `${tempPrefix}-copy-${fixture.id}-`),
          )
          const tmp = join(dir, 'copy.dcm')
          await copyFile(fixture.dicomPath, tmp)
          const after = runDciodvfy(tmp, bin!)
          const { ok, introduced } = isConformanceNonRegression(before, after)
          expect(ok).toBe(true)
          expect(introduced).toEqual([])
          await rm(dir, { recursive: true, force: true })
        },
      )

      it.skipIf(!bin)(
        'passthrough curate introduces no new dciodvfy violations',
        async () => {
          const baseline = hasBaseline
            ? baselineViolationSet(fixture.baselinePath!)
            : undefined
          const before = runDciodvfy(fixture.dicomPath, bin!)
          const outDir = await mkdtemp(
            join(tmpdir(), `${tempPrefix}-curate-${fixture.id}-`),
          )
          const curated = await runPassthroughCurate(fixture.dicomPath, outDir)
          const after = runDciodvfy(curated, bin!)
          const { ok, introduced } = assertPassthroughNonRegression(
            before,
            after,
            baseline,
          )
          expect(ok, introduced.join('\n')).toBe(true)
          expect(introduced).toEqual([])
          await rm(outDir, { recursive: true, force: true })
        },
      )
    })
  }
}
