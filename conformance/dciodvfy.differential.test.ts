/**
 * Synthetic fixture dciodvfy regression (default CI).
 *
 * Per variant from dicom-synth: baseline drift vs baselines/synthetic/*.json,
 * control cases, then passthrough curateOne must not introduce new violations.
 *
 * See README.md — "Test files" and "How to read results".
 */
import { describe } from 'vitest'
import { registerDifferentialConformanceTests } from './differentialSuite'
import { syntheticConformanceCases } from './helpers'

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
