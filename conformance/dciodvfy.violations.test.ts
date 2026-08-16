/**
 * Declared-violation dciodvfy regression (default CI).
 *
 * One fixture per class in dicom-synth's violation vocabulary, each a valid CT
 * image with exactly one deliberate deviation applied. Same checks as the
 * differential suite: baseline drift, control cases, then passthrough curateOne
 * must not introduce new violations.
 *
 * The point is the last one. A deliberately malformed input is where a curation
 * pass is most likely to "helpfully" normalise something on rewrite — these
 * pin that it does not.
 *
 * See README.md — "Test files" and "How to read results".
 */
import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { baselineViolationSet } from './baseline'
import { describeSyntheticConformance } from './differentialSuite'
import {
  CLEAN_FIXTURE_ID,
  syntheticBaselinePath,
  VIOLATION_CLASSES,
  writeSyntheticViolationFixtures,
} from './helpers'

/**
 * Classes whose deviation is real in the bytes but invisible to dciodvfy's
 * *normalised* violation set, so their baseline cannot differ from the clean
 * fixture's. The discrimination check below inverts for these — asserting
 * equality with the clean baseline — so the exemption fails loudly the moment
 * it stops being true.
 */
const INDISTINGUISHABLE_FROM_CLEAN: Partial<
  Record<(typeof VIOLATION_CLASSES)[number], string>
> = {
  // Strips the preamble + 'DICM' magic (694 -> 562 bytes), but dciodvfy falls
  // back to guessing the transfer syntax and reports the same dataset-level
  // findings either way. The passthrough check still earns its place: it pins
  // that curateOne introduces nothing new given a header-less file.
  'missing-meta-header':
    'dciodvfy reports identical dataset findings with and without the meta header',
}

// Not exempt, but worth knowing: missing-type1-tag nets -22 findings against
// the clean fixture, because dciodvfy stops resolving the IOD once the tag is
// gone. It passes the checks below on a much shallower surface than the rest.

await describeSyntheticConformance({
  title: 'dciodvfy declared-violation conformance',
  prefix: 'dc-violation',
  writeFixtures: writeSyntheticViolationFixtures,
  extraTests: (cases) => {
    // Guards the generator itself: a silently dropped entry would otherwise
    // just mean fewer tests registered, which no assertion would notice.
    it('generates one fixture per declared violation class', () => {
      expect(cases.map((c) => c.id).sort()).toEqual(
        VIOLATION_CLASSES.map((v) => `violation-${v}`).sort(),
      )
    })

    // A fixture whose violation produces no change in dciodvfy's output still
    // registers four passing tests while pinning nothing — the same vacuous
    // shape the four checks exist to catch. Compare each against the clean
    // baseline so a neutered fixture fails loudly instead of going green.
    const cleanBaseline = syntheticBaselinePath(CLEAN_FIXTURE_ID)

    it('clean baseline exists for the discrimination checks', () => {
      expect(
        existsSync(cleanBaseline),
        `${cleanBaseline} is missing — CLEAN_FIXTURE_ID must name a ` +
          'CONFORMANCE_SPEC fixture with a committed baseline',
      ).toBe(true)
    })

    for (const violation of VIOLATION_CLASSES) {
      const exemptReason = INDISTINGUISHABLE_FROM_CLEAN[violation]

      const diffFromClean = () => {
        const clean = baselineViolationSet(cleanBaseline)
        const dirty = baselineViolationSet(
          syntheticBaselinePath(`violation-${violation}`),
        )
        const added = [...dirty].filter((v) => !clean.has(v))
        const removed = [...clean].filter((v) => !dirty.has(v))
        return added.length + removed.length
      }

      if (exemptReason) {
        it(`${violation} is indistinguishable from clean (exempt)`, () => {
          expect(
            diffFromClean(),
            `exemption no longer holds (${exemptReason}) — the baseline now ` +
              'differs from the clean fixture, so remove this class from ' +
              'INDISTINGUISHABLE_FROM_CLEAN',
          ).toBe(0)
        })
      } else {
        it(`${violation} changes what dciodvfy reports`, () => {
          expect(
            diffFromClean(),
            'baseline is identical to the clean fixture — this pins nothing',
          ).toBeGreaterThan(0)
        })
      }
    }
  },
})
