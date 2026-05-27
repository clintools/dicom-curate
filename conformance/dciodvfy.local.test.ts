/**
 * Optional local DICOM corpus. Runs when `CONFORMANCE_LOCAL_PATH` is set.
 *
 * See README.md — "Local and private fixtures".
 */
import { describe, expect, it } from 'vitest'
import { registerDifferentialConformanceTests } from './differentialSuite'
import {
  parseConformanceLocalPathEnv,
  tryResolveLocalConformanceCases,
} from './localFixtures'

describe.skipIf(parseConformanceLocalPathEnv().length === 0)(
  'dciodvfy local fixtures',
  () => {
    const resolved = tryResolveLocalConformanceCases()
    if (!resolved.ok) {
      it('CONFORMANCE_LOCAL_PATH is invalid', () => {
        throw resolved.error
      })
      return
    }

    if (resolved.cases.length === 0) {
      it('CONFORMANCE_LOCAL_PATH resolved to no fixtures', () => {
        expect.fail('No .dcm files discovered')
      })
      return
    }

    registerDifferentialConformanceTests(resolved.cases, 'dc-local')
  },
)
