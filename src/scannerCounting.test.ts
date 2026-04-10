/**
 * Integration tests for the scanner's parallel counter+feeder architecture.
 *
 * The scan worker runs two concurrent traversals:
 * - Counter: fast, cheap-filter-only pass that emits 'count' messages
 * - Feeder: full-filter pass that emits 'file' messages, subject to backpressure
 *
 * The counter finishes well before the feeder, giving an accurate totalFiles
 * early in the run. When files fail the full filter (but passed the cheap
 * filter), the feeder corrects the count with decremented 'count' messages.
 */

import { cpus } from 'node:os'
import {
  cleanupTestDicomDir,
  createTestDicomDir,
} from '../testutils/dicomFixtures'
import {
  configureMockMappingWorkers,
  getNextMockBehavior,
  MockWorker,
  registerMockWorker,
  resetMockWorkers,
} from '../testutils/mockMappingWorker'
import {
  configureParallelScanWorker,
  ParallelScanWorker,
  resetParallelScanWorker,
} from '../testutils/mockParallelScanWorker'
import type { TCurationSpecification, TProgressMessage } from './types'

// ---------------------------------------------------------------------------
// Track the scan worker instance so tests can inspect it
// ---------------------------------------------------------------------------

let scanWorkerInstance: ParallelScanWorker | undefined

vi.doMock('./worker', () => ({
  createWorker: async (scriptPath: string | URL, _options?: any) => {
    const urlStr = scriptPath.toString()

    if (urlStr.includes('scanDirectoryWorker')) {
      scanWorkerInstance = new ParallelScanWorker()
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

const WORKER_COUNT = Math.max(1, Math.min(cpus().length || 1, 8))

function minimalSpec() {
  return {
    version: '3.0' as const,
    hostProps: {
      protocolNumber: 'scanner-counting-test',
    },
  } as unknown as TCurationSpecification
}

describe('parallel counter + feeder', () => {
  let largeDir: string
  let smallDir: string

  beforeAll(() => {
    largeDir = createTestDicomDir(200, {
      studyDescription: 'Parallel Counter Test',
      subdirName: 'PC-001',
    })
    smallDir = createTestDicomDir(10, {
      studyDescription: 'Small Dataset Test',
      subdirName: 'SD-001',
    })
  })

  afterAll(() => {
    cleanupTestDicomDir(largeDir)
    cleanupTestDicomDir(smallDir)
  })

  afterEach(() => {
    scanWorkerInstance?.terminate()
    resetMockWorkers()
    resetParallelScanWorker()
    scanWorkerInstance = undefined
  })

  it('all files processed correctly', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(200)
    expect(result.totalFiles).toBe(200)
    expect(result.mapResultsList).toHaveLength(200)

    const errors = result.mapResultsList!.filter(
      (r) => r.errors && r.errors.length > 0,
    )
    expect(errors).toHaveLength(0)
  })

  it('totalFiles jumps to full count early (counter finishes before feeder)', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(200)

    const progressOnly = progressMessages.filter(
      (m) => m.response === 'progress',
    )
    expect(progressOnly.length).toBeGreaterThan(0)

    // The counter emits all 'count' messages synchronously before the
    // feeder starts emitting 'file' messages. So by the time the first
    // progress message fires, totalFiles should already be 200.
    const firstProgress = progressOnly[0]
    expect(firstProgress.totalFiles).toBe(200)
  })

  it('processedFiles never exceeds totalFiles', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(200)

    const progressOnly = progressMessages.filter(
      (m) => m.response === 'progress',
    )

    // With parallel counter, totalFiles is always >= processedFiles
    // (the counter finishes first, then the feeder catches up).
    const violations = progressOnly.filter(
      (m) => (m.processedFiles ?? 0) > (m.totalFiles ?? 0),
    )
    expect(violations).toHaveLength(0)
  })

  it('count correction when files fail the full filter', async () => {
    // Configure 5 files to be rejected by the feeder (simulating DICOM
    // signature check failures on files that passed the cheap filter).
    configureParallelScanWorker({ rejectCount: 5 })
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: largeDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    // 200 files total, 5 rejected = 195 actually processed
    expect(result.processedFiles).toBe(195)
    expect(result.totalFiles).toBe(195)

    // The final totalFiles should match processedFiles (corrections applied)
    const lastProgress = progressMessages
      .filter((m) => m.response === 'progress')
      .pop()
    expect(lastProgress?.totalFiles).toBe(195)
  })

  it('small dataset works correctly', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const progressMessages: TProgressMessage[] = []
    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: smallDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.totalFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)

    const progressOnly = progressMessages.filter(
      (m) => m.response === 'progress',
    )
    expect(progressOnly.length).toBeGreaterThan(0)

    for (const msg of progressOnly) {
      expect(msg.totalFiles).toBeLessThanOrEqual(10)
    }
  })

  it('abort terminates cleanly', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()
    let aborted = false

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: largeDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller.signal,
        },
        (msg) => {
          if (msg.response === 'progress' && !aborted) {
            aborted = true
            controller.abort()
          }
        },
      )
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error.name).toBe('AbortError')
    }

    expect(scanWorkerInstance?.terminated).toBe(true)
  })
})
