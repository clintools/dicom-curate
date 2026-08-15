/**
 * Synthetic fixture dciodvfy regression (default CI).
 *
 * Per variant from dicom-synth: baseline drift vs baselines/synthetic/*.json,
 * control cases, then passthrough curateOne must not introduce new violations.
 *
 * See README.md — "Test files" and "How to read results".
 */
import { describeSyntheticConformance } from './differentialSuite'
import { writeSyntheticConformanceFixtures } from './helpers'

await describeSyntheticConformance({
  title: 'dciodvfy differential conformance',
  prefix: 'dc-dciod',
  writeFixtures: writeSyntheticConformanceFixtures,
})
