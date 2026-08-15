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
import { expect, it } from 'vitest'
import { baselineViolationSet } from './baseline'
import { describeSyntheticConformance } from './differentialSuite'
import {
  syntheticBaselinePath,
  VIOLATION_CLASSES,
  writeSyntheticViolationFixtures,
} from './helpers'

/**
 * Classes whose deviation is real in the bytes but invisible to dciodvfy's
 * *normalised* violation set, so their baseline cannot differ from the clean
 * fixture's. Exempted from the discrimination check below, with the reason.
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
    const cleanBaseline = syntheticBaselinePath('valid-image-0')

    for (const violation of VIOLATION_CLASSES) {
      const exemptReason = INDISTINGUISHABLE_FROM_CLEAN[violation]

      it.skipIf(exemptReason)(
        `${violation} changes what dciodvfy reports`,
        () => {
          const clean = baselineViolationSet(cleanBaseline)
          const dirty = baselineViolationSet(
            syntheticBaselinePath(`violation-${violation}`),
          )
          const added = [...dirty].filter((v) => !clean.has(v))
          const removed = [...clean].filter((v) => !dirty.has(v))
          expect(
            added.length + removed.length,
            'baseline is identical to the clean fixture — this pins nothing',
          ).toBeGreaterThan(0)
        },
      )
    }
  },
})
