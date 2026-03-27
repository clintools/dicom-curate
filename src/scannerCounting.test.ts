/**
 * Integration tests for the scanner's count-while-paused feature.
 *
 * These tests exercise the full curateMany pipeline with a mock scan worker
 * that simulates the backpressure counting behavior: when the main thread
 * sends 'stop', the scanner switches from emitting 'file' messages to
 * emitting 'count' messages (cheap metadata-only counting). On 'resume',
 * it drains the buffered files as 'file' messages, optionally rejecting
 * some (self-correcting the count).
 *
 * IMPORTANT: The mapping worker pool uses LIFO (stack) dispatch -- the last
 * worker pushed to availableMappingWorkers is the first to receive work.
 */

import { jest } from '@jest/globals'
import { cpus } from 'node:os'

import {
  MockWorker,
  configureMockMappingWorkers,
  resetMockWorkers,
  getNextMockBehavior,
  registerMockWorker,
} from '../testutils/mockMappingWorker'
import {
  BackpressureScanWorker,
  resetBackpressureScanWorker,
} from '../testutils/mockBackpressureScanWorker'
import {
  createTestDicomDir,
  cleanupTestDicomDir,
} from '../testutils/dicomFixtures'
import type { TProgressMessage } from './types'

// ---------------------------------------------------------------------------
// Track the scan worker instance so tests can inspect it
// ---------------------------------------------------------------------------

let scanWorkerInstance: BackpressureScanWorker | undefined

jest.unstable_mockModule('./worker', () => ({
  createWorker: async (scriptPath: string | URL, _options?: any) => {
    const urlStr = scriptPath.toString()

    if (urlStr.includes('scanDirectoryWorker')) {
      scanWorkerInstance = new BackpressureScanWorker()
      return scanWorkerInstance as unknown as Worker
    }

    const behavior = getNextMockBehavior()
    const mock = new MockWorker(behavior)
    registerMockWorker(mock)
    return mock as unknown as Worker
  },
  fixupNodeWorkerEnvironment: async () => {},
}))

const { curateMany } = await import('./index')

const WORKER_COUNT = Math.min(cpus().length, 8)

function minimalSpec() {
  return {
    version: '3.0' as const,
    hostProps: {
      protocolNumber: 'scanner-counting-test',
    },
  }
}

describe('scanner counting during backpressure', () => {
  // Large dataset: 200 files, enough to trigger HIGH_WATER_MARK (100)
  let largeDir: string
  // Small dataset: 10 files, below HIGH_WATER_MARK
  let smallDir: string

  beforeAll(() => {
    largeDir = createTestDicomDir(200, {
      studyDescription: 'Backpressure Counting Test',
      subdirName: 'BP-001',
    })
    smallDir = createTestDicomDir(10, {
      studyDescription: 'No Backpressure Test',
      subdirName: 'NBP-001',
    })
  })

  afterAll(() => {
    cleanupTestDicomDir(largeDir)
    cleanupTestDicomDir(smallDir)
  })

  afterEach(() => {
    resetMockWorkers()
    resetBackpressureScanWorker()
    scanWorkerInstance = undefined
  })

  it('all files processed when scanner counts ahead during backpressure', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(200)
    expect(result.totalFiles).toBe(200)
    expect(result.mapResultsList).toHaveLength(200)

    // No errors in results
    const errors = result.mapResultsList!.filter(
      (r) => r.errors && r.errors.length > 0,
    )
    expect(errors).toHaveLength(0)
  })

  it('progress totalFiles reflects discovered count, not just queue size', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(200)

    // With 200 files and HIGH_WATER_MARK=100, the scanner will be paused
    // and start counting. At least some progress messages should have
    // totalFiles > the number of files that could possibly be in the queue
    // at that point (i.e., totalDiscoveredFiles is being used).
    //
    // Without the counting feature, totalFiles would hover near
    // processedFiles (because the scanner is paused at ~100 queued files).
    // With counting, totalFiles should jump to a much higher number as
    // the scanner counts ahead.
    const progressOnly = progressMessages.filter(
      (m) => m.response === 'progress',
    )
    expect(progressOnly.length).toBeGreaterThan(0)

    // Find the maximum totalFiles reported during progress
    const maxTotalFiles = Math.max(
      ...progressOnly.map((m) => m.totalFiles ?? 0),
    )
    // It should be 200 (or close to it) because the scanner counted ahead
    expect(maxTotalFiles).toBe(200)
  })

  it('small dataset works without backpressure — fallback formula used', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: smallDir,
        curationSpec: minimalSpec,
        skipWrite: true,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.totalFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)

    // With only 10 files, backpressure should never trigger. The scan
    // worker should never receive a 'stop' message, so no 'count'
    // messages are emitted. Progress uses the queue-based fallback.
    const progressOnly = progressMessages.filter(
      (m) => m.response === 'progress',
    )
    expect(progressOnly.length).toBeGreaterThan(0)

    // All totalFiles values should be <= 10 and consistent
    for (const msg of progressOnly) {
      expect(msg.totalFiles).toBeLessThanOrEqual(10)
    }
  })

  it('abort during counting phase terminates cleanly', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()
    let abortedDuringCounting = false

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: largeDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          signal: controller.signal,
        },
        (msg) => {
          // Abort after a few progress messages (scanner should be
          // in counting mode by then with 200 files)
          if (msg.response === 'progress' && !abortedDuringCounting) {
            abortedDuringCounting = true
            controller.abort()
          }
        },
      )
      // Should not reach here — curateMany should reject
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error.name).toBe('AbortError')
    }

    // Verify the scan worker was terminated
    expect(scanWorkerInstance?.terminated).toBe(true)
  })
})
