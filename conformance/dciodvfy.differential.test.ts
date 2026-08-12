/**
 * Synthetic fixture dciodvfy regression (default CI).
 *
 * Per variant from dicom-synth: baseline drift vs baselines/synthetic/*.json,
 * control cases, then passthrough curateOne must not introduce new violations.
 *
 * See README.md — "Test files" and "How to read results".
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it } from 'vitest'
import { registerDifferentialConformanceTests } from './differentialSuite'
import {
  resolveConformanceBin,
  writeSyntheticConformanceFixtures,
} from './helpers'

// Fixtures are spec-driven and ephemeral: write them to a temp dir once, then
// register the per-fixture dciodvfy tests from the resulting cases.
//
// Without the binary nothing is written at all: every test would be skipIf-ed,
// and Vitest runs no file-level hook once a whole file is skipped, so afterAll
// would never fire and the temp dir would leak. The placeholder keeps the file
// non-empty — Vitest fails a suite that registers no tests.
const bin = resolveConformanceBin()

if (bin) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-conformance-synth-'))
  const syntheticConformanceCases = await writeSyntheticConformanceFixtures(dir)

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('dciodvfy differential conformance', () => {
    registerDifferentialConformanceTests(
      syntheticConformanceCases.map((f) => ({
        id: f.id,
        dicomPath: f.dicomPath,
        baselinePath: f.baselinePath,
      })),
      'dc-dciod',
    )
  })
} else {
  describe.skip('dciodvfy differential conformance', () => {
    it('requires dciodvfy on PATH', () => {})
  })
}
