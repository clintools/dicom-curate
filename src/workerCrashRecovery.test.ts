/**
 * Integration tests for mapping worker crash recovery.
 *
 * Both scan and mapping workers are mocked:
 * - Scan workers use MockScanWorker that reads real files from disk
 * - Mapping workers use MockWorker with configurable crash behaviors
 *
 * Test DICOM files are created on disk via testutils/dicomFixtures.
 *
 * IMPORTANT: The mapping worker pool uses LIFO (stack) dispatch -- the last
 * worker pushed to availableMappingWorkers is the first to receive work.
 * Since workers are created in index order, worker[N-1] gets the first file.
 * Crash workers should be placed at the END of the behaviors array so they
 * are guaranteed to receive files.
 */

import { jest } from '@jest/globals'

import {
  MockWorker,
  configureMockMappingWorkers,
  resetMockWorkers,
  getMockWorkersCreated,
  getNextMockBehavior,
  registerMockWorker,
} from '../testutils/mockMappingWorker'
import type { MockWorkerBehavior } from '../testutils/mockMappingWorker'
import { MockScanWorker } from '../testutils/mockScanWorker'
import {
  createTestDicomDir,
  cleanupTestDicomDir,
} from '../testutils/dicomFixtures'

jest.unstable_mockModule('./worker', () => ({
  createWorker: async (scriptPath: string | URL, _options?: any) => {
    const urlStr = scriptPath.toString()

    if (urlStr.includes('scanDirectoryWorker')) {
      return new MockScanWorker() as unknown as Worker
    }

    const behavior = getNextMockBehavior()
    const mock = new MockWorker(behavior)
    registerMockWorker(mock)
    return mock as unknown as Worker
  },
  fixupNodeWorkerEnvironment: async () => {},
}))

const { curateMany } = await import('./index')

const WORKER_COUNT = Math.min(navigator.hardwareConcurrency, 8)

/** Create a behaviors array with normal workers first, crash workers last (LIFO). */
function makeBehaviors(
  ...crashBehaviors: MockWorkerBehavior[]
): MockWorkerBehavior[] {
  const normals: MockWorkerBehavior[] = Array(
    WORKER_COUNT - crashBehaviors.length,
  ).fill('normal')
  // Crash workers go last so they're popped first from the LIFO stack
  return [...normals, ...crashBehaviors]
}

function minimalSpec() {
  return {
    version: '3.0' as const,
    hostProps: {
      protocolNumber: 'crash-recovery-test',
    },
  }
}

describe('worker crash recovery', () => {
  let testDir: string

  beforeAll(() => {
    testDir = createTestDicomDir(10)
  })

  afterAll(() => {
    cleanupTestDicomDir(testDir)
  })

  afterEach(() => {
    resetMockWorkers()
  })

  it('all files process normally with no crashes (baseline)', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)

    const errors = result.mapResultsList!.filter(
      (r) => r.errors && r.errors.length > 0,
    )
    expect(errors).toHaveLength(0)
  })

  it('recovers from onerror and reports file as mapping error', async () => {
    configureMockMappingWorkers(makeBehaviors('crash-onerror'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)

    const crashErrors = result.mapResultsList!.filter((r) =>
      r.errors?.some((e) => e.includes('Simulated worker crash')),
    )
    expect(crashErrors.length).toBeGreaterThanOrEqual(1)

    // Replacement worker created (total > initial pool size)
    expect(getMockWorkersCreated().length).toBeGreaterThan(WORKER_COUNT)
  })

  it('recovers from unexpected exit (non-zero code)', async () => {
    configureMockMappingWorkers(makeBehaviors('crash-exit'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)

    const exitErrors = result.mapResultsList!.filter((r) =>
      r.errors?.some((e) => e.includes('exited unexpectedly')),
    )
    expect(exitErrors.length).toBeGreaterThanOrEqual(1)
  })

  it('handles multiple worker crashes without hanging', async () => {
    configureMockMappingWorkers(
      makeBehaviors('crash-onerror', 'crash-exit', 'crash-onerror'),
    )

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)

    const allErrors = result.mapResultsList!.filter(
      (r) => r.errors && r.errors.length > 0,
    )
    expect(allErrors.length).toBeGreaterThanOrEqual(1)
  })

  it('double-recovery guard prevents counting file twice', async () => {
    configureMockMappingWorkers(makeBehaviors('crash-onerror-and-exit'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)
  })

  it('stall watchdog terminates stuck workers', async () => {
    jest.useFakeTimers()

    configureMockMappingWorkers(makeBehaviors('hang'))

    const curatePromise = curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    // The mock scan worker uses setTimeout(0) per file, and mock mapping
    // workers use setTimeout(0) for responses. With fake timers, each
    // jest.advanceTimersByTime() + microtask flush processes one tick.
    // We need enough ticks for: 10 file emissions + 9 normal worker
    // responses + dispatch cycles.
    for (let i = 0; i < 200; i++) {
      jest.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    // Now 9 normal files should be processed and 1 is stuck (hanging).
    // Advance past the stall watchdog timeout (10 minutes).
    // The watchdog checks every 60s, so advance in 60s chunks.
    for (let i = 0; i < 11; i++) {
      jest.advanceTimersByTime(60 * 1000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    // Let the recovery, replacement worker creation, and final dispatch complete
    for (let i = 0; i < 50; i++) {
      jest.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    const result = await curatePromise

    jest.useRealTimers()

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)

    const stallErrors = result.mapResultsList!.filter((r) =>
      r.errors?.some((e) => e.includes('stalled')),
    )
    expect(stallErrors.length).toBeGreaterThanOrEqual(1)
  }, 30_000)
})
