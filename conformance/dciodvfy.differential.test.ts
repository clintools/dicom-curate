/**
 * Synthetic fixture dciodvfy regression (default CI).
 *
 * Per variant from dicom-synth: baseline drift vs baselines/synthetic/*.json,
 * control cases, then passthrough curateOne must not introduce new violations.
 *
 * See README.md — "Test files" and "How to read results".
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'
import { registerDifferentialConformanceTests } from './differentialSuite'
import { writeSyntheticConformanceFixtures } from './helpers'

// Fixtures are spec-driven and ephemeral: write them to a temp dir once, then
// register the per-fixture dciodvfy tests from the resulting cases.
const dir = mkdtempSync(join(tmpdir(), 'dc-conformance-synth-'))
const syntheticConformanceCases = await writeSyntheticConformanceFixtures(dir)

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
