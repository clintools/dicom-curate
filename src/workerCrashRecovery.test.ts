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

import { cpus } from 'node:os'
import {
  cleanupTestDicomDir,
  createTestDicomDir,
} from '../testutils/dicomFixtures'
import type { MockWorkerBehavior } from '../testutils/mockMappingWorker'
import {
  configureMockMappingWorkers,
  getMockWorkersCreated,
  getNextMockBehavior,
  MockWorker,
  registerMockWorker,
  resetMockWorkers,
} from '../testutils/mockMappingWorker'
import { MockScanWorker } from '../testutils/mockScanWorker'
import type { TCurationSpecification, TProgressMessage } from './types'

let scanWorkerInstance: MockScanWorker | undefined

vi.doMock('./worker', () => ({
  createWorker: async (scriptPath: string | URL, _options?: any) => {
    const urlStr = scriptPath.toString()

    if (urlStr.includes('scanDirectoryWorker')) {
      scanWorkerInstance = new MockScanWorker()
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
// Imported alongside curateMany so a test can drive the pool into states the
// public API can no longer produce -- the wedge the watchdog exists to break.
const pool = await import('./mappingWorkerPool')

const WORKER_COUNT = Math.max(3, Math.min(cpus().length || 1, 8))

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

async function flushMicrotasks(rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
}

/** Let any already-scheduled setTimeout(0) work run to completion. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Drive real timers until `predicate` holds; the mock workers reply on setTimeout(0). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 500; tick++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('waitFor: condition was never met')
}

function queuedFile(name: string) {
  return {
    fileInfo: { kind: 'path', path: '/wedged', name, size: 1 } as any,
    scanAnomalies: [],
  }
}

function minimalSpec() {
  return {
    version: '3.0' as const,
    hostProps: {
      protocolNumber: 'crash-recovery-test',
    },
  } as unknown as TCurationSpecification
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
    scanWorkerInstance?.terminate()
    scanWorkerInstance = undefined
    vi.useRealTimers()
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
        workerCount: WORKER_COUNT,
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
        workerCount: WORKER_COUNT,
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
        workerCount: WORKER_COUNT,
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
        workerCount: WORKER_COUNT,
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
        workerCount: WORKER_COUNT,
      },
      () => {},
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)
  })

  it('stall watchdog terminates stuck workers', async () => {
    vi.useFakeTimers()

    configureMockMappingWorkers(makeBehaviors('hang'))

    const curatePromise = curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
      },
      () => {},
    )

    // The mock scan worker uses setTimeout(0) per file, and mock mapping
    // workers use setTimeout(0) for responses. With fake timers, each
    // vi.advanceTimersByTime() + microtask flush processes one tick.
    // We need enough ticks for: 10 file emissions + 9 normal worker
    // responses + dispatch cycles.
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    // Now 9 normal files should be processed and 1 is stuck (hanging).
    // Advance past the stall watchdog timeout (10 minutes).
    // The watchdog checks every 60s, so advance in 60s chunks.
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(60 * 1000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    // Let the recovery, replacement worker creation, and final dispatch complete
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    const result = await curatePromise

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)

    const stallErrors = result.mapResultsList!.filter((r) =>
      r.errors?.some((e) => e.includes('stalled')),
    )
    expect(stallErrors.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('stall watchdog re-pumps a stalled dispatch with no active workers', async () => {
    vi.useFakeTimers()

    configureMockMappingWorkers(['normal'])

    const curatePromise = curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: 1,
      },
      () => {},
    )

    // Let the async setup finish without advancing any timer, so the scan
    // worker never emits.
    await flushMicrotasks(20)

    // Reproduce the wedge a killed pump leaves behind: work queued, scan
    // finished, nothing active and no dispatch pending. Injected rather than
    // provoked, because the pump can no longer be killed from a callback.
    scanWorkerInstance!.terminate()
    pool.filesToProcess.push(
      queuedFile('wedged-1.dcm'),
      queuedFile('wedged-2.dcm'),
    )
    pool.setDirectoryScanFinished(true)

    // The previous gate (workersActive > 0) could never fire in this state,
    // so the run hung here indefinitely.
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(60 * 1000)
      await flushMicrotasks()
    }

    // Let the re-pumped dispatch and the worker responses drain.
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(1)
      await flushMicrotasks()
    }

    const result = await curatePromise

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(2)
  }, 30_000)

  it('emits done once when the last worker crashes at end of run', async () => {
    const singleFileDir = createTestDicomDir(1)

    try {
      configureMockMappingWorkers(['hang'])

      const doneMessages: TProgressMessage[] = []
      const curatePromise = curateMany(
        {
          inputType: 'path',
          inputDirectory: singleFileDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: 1,
        },
        (msg) => {
          if (msg.response === 'done') doneMessages.push(msg)
        },
      )

      // Crash only once the sole file is in flight and the scan has finished,
      // so recovery runs with an empty queue - the end-of-run case where the
      // termination condition is already satisfied.
      await waitFor(
        () => pool.directoryScanFinished && pool.getWorkersActive() === 1,
      )

      // A hard scan read-failure is reported from the termination block, so a
      // second pass through it appends this entry to mapResultsList twice.
      pool.scanAnomalies.push({
        fileInfo: {
          kind: 'path',
          path: singleFileDir,
          name: 'unreadable.dcm',
        } as any,
        anomalies: [],
        errors: ['Simulated read failure'],
      })

      const [crashed] = getMockWorkersCreated()
      crashed.onerror!({ message: 'Simulated end-of-run crash' })

      const result = await curatePromise

      // Give the replacement worker time to be created and dispatched: doing
      // that after 'done' rather than before can produce duplicates.
      await settle()
      expect(getMockWorkersCreated()).toHaveLength(2)

      expect(result.response).toBe('done')
      expect(doneMessages).toHaveLength(1)
      expect(
        result.mapResultsList!.filter((r) =>
          r.sourceInstanceUID.startsWith('scan_'),
        ),
      ).toHaveLength(1)
      expect(result.mapResultsList).toHaveLength(2)

      // Torn down with the pool rather than left running past the run.
      expect(getMockWorkersCreated()[1].terminated).toBe(true)
    } finally {
      cleanupTestDicomDir(singleFileDir)
    }
  }, 30_000)
})
