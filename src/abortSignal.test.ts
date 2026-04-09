/**
 * Integration tests for AbortSignal support in curateMany.
 *
 * Both scan and mapping workers are mocked (same pattern as
 * workerCrashRecovery.test.ts). Tests verify that aborting curateMany:
 * - Terminates all workers
 * - Rejects with a DOMException (name: 'AbortError')
 * - Leaves module-level state clean for subsequent runs
 *
 * IMPORTANT: The mapping worker pool uses LIFO (stack) dispatch -- the last
 * worker pushed to availableMappingWorkers is the first to receive work.
 */

import {
  vi,
  describe,
  beforeAll,
  afterAll,
  afterEach,
  expect,
  it,
} from 'vitest'
import { cpus } from 'node:os'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

// ---------------------------------------------------------------------------
// Slow scan worker: emits files with a configurable delay between each.
// This lets us abort mid-scan reliably. Standalone implementation that
// mirrors MockScanWorker's interface without inheriting (emit is private).
// ---------------------------------------------------------------------------

function listFiles(dir: string, base: string = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), rel))
    } else {
      files.push(rel)
    }
  }
  return files
}

class SlowScanWorker {
  public onerror: ((event: any) => void) | null = null
  public terminated = false
  public emissionDelay: number

  private messageListeners: ((event: { data: any }) => void)[] = []
  private pendingEmitTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(emissionDelay = 50) {
    this.emissionDelay = emissionDelay
  }

  addEventListener(event: string, listener: any): void {
    if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  on(event: string, listener: any): void {
    if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  postMessage(data: any): void {
    if (this.terminated) return
    if (data.request !== 'scan') return

    const scanDir = data.path || data.directoryHandle
    if (!scanDir || typeof scanDir !== 'string') {
      this.emit({
        response: 'error',
        error: 'No path provided to slow scan worker',
      })
      return
    }

    const files = listFiles(scanDir)

    let i = 0
    const emitNext = () => {
      this.pendingEmitTimeout = null
      if (this.terminated) return
      if (i < files.length) {
        const relPath = files[i]
        const parts = relPath.split('/')
        const name = parts.pop()!
        const path = parts.join('/')
        const fullPath = join(scanDir, relPath)
        const stat = statSync(fullPath)

        this.emit({
          response: 'file',
          fileInfo: {
            kind: 'path',
            path: join(scanDir, path),
            name,
            size: stat.size,
          },
        })
        i++
        this.pendingEmitTimeout = setTimeout(emitNext, this.emissionDelay)
      } else {
        this.emit({ response: 'done' })
      }
    }
    this.pendingEmitTimeout = setTimeout(emitNext, this.emissionDelay)
  }

  terminate(): void {
    this.terminated = true
    if (this.pendingEmitTimeout) {
      clearTimeout(this.pendingEmitTimeout)
      this.pendingEmitTimeout = null
    }
  }

  private emit(data: any): void {
    for (const listener of this.messageListeners) {
      listener({ data })
    }
  }
}

// ---------------------------------------------------------------------------
// Test setup: mock worker factory
// ---------------------------------------------------------------------------

// Track whether we're using slow scan workers for specific tests
let useSlowScanWorker = false
let slowScanDelay = 50
let scanWorkerInstance: MockScanWorker | SlowScanWorker | undefined

vi.doMock('./worker', () => ({
  createWorker: async (scriptPath: string | URL, _options?: any) => {
    const urlStr = scriptPath.toString()

    if (urlStr.includes('scanDirectoryWorker')) {
      if (useSlowScanWorker) {
        scanWorkerInstance = new SlowScanWorker(slowScanDelay)
      } else {
        scanWorkerInstance = new MockScanWorker()
      }
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

const WORKER_COUNT = Math.max(3, Math.min(cpus().length || 1, 8))

function minimalSpec() {
  return {
    version: '3.0' as const,
    hostProps: {
      protocolNumber: 'abort-signal-test',
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AbortSignal support', () => {
  let testDir: string

  beforeAll(() => {
    testDir = createTestDicomDir(10)
  })

  afterAll(() => {
    cleanupTestDicomDir(testDir)
  })

  afterEach(() => {
    scanWorkerInstance?.terminate()
    resetMockWorkers()
    useSlowScanWorker = false
    slowScanDelay = 50
    scanWorkerInstance = undefined
  })

  it('rejects immediately with a pre-aborted signal (no workers created)', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()
    controller.abort()

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: testDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller.signal,
        },
        () => {},
      )
      // Should not reach here
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error).toBeInstanceOf(DOMException)
      expect(error.name).toBe('AbortError')
      expect(error.message).toBe('The operation was aborted.')
    }

    // No mapping workers should have been created
    expect(getMockWorkersCreated()).toHaveLength(0)
  })

  it('aborts during scanning phase — workers terminated, rejects with AbortError', async () => {
    useSlowScanWorker = true
    slowScanDelay = 30

    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()

    // Count progress messages to know when files start flowing
    let progressCount = 0
    const progressCallback = () => {
      progressCount++
      // Abort after a few files have been dispatched
      if (progressCount >= 2) {
        controller.abort()
      }
    }

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: testDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller.signal,
        },
        progressCallback,
      )
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error).toBeInstanceOf(DOMException)
      expect(error.name).toBe('AbortError')
    }

    // Scan worker should have been terminated
    expect(scanWorkerInstance!.terminated).toBe(true)

    // All mapping workers should be terminated
    const allWorkers = getMockWorkersCreated()
    for (const worker of allWorkers) {
      expect(worker.terminated).toBe(true)
    }

    // Should have processed fewer than all 10 files
    expect(progressCount).toBeLessThan(10)
  })

  it('aborts during mapping phase (scan complete) — rejects with AbortError', async () => {
    // Use fast scan so all files are queued quickly
    useSlowScanWorker = false

    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()

    let progressCount = 0
    const progressCallback = () => {
      progressCount++
      // Abort after a few files are mapped (but before all 10)
      if (progressCount >= 3) {
        controller.abort()
      }
    }

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: testDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller.signal,
        },
        progressCallback,
      )
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error).toBeInstanceOf(DOMException)
      expect(error.name).toBe('AbortError')
    }

    // All mapping workers should be terminated
    const allWorkers = getMockWorkersCreated()
    for (const worker of allWorkers) {
      expect(worker.terminated).toBe(true)
    }
  })

  it('abort after natural completion is a no-op', async () => {
    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller = new AbortController()

    const result = await curateMany(
      {
        inputType: 'path',
        inputDirectory: testDir,
        curationSpec: minimalSpec,
        skipWrite: true,
        workerCount: WORKER_COUNT,
        signal: controller.signal,
      },
      () => {},
    )

    // Now abort after completion
    controller.abort()

    // The original result should be intact
    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(10)
    expect(result.mapResultsList).toHaveLength(10)
  })

  it('sequential calls: abort then re-run completes successfully', async () => {
    // First run: abort it
    useSlowScanWorker = true
    slowScanDelay = 30

    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    const controller1 = new AbortController()

    let progressCount = 0
    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: testDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller1.signal,
        },
        () => {
          progressCount++
          if (progressCount >= 2) {
            controller1.abort()
          }
        },
      )
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error.name).toBe('AbortError')
    }

    // Reset mocks for the second run — stop the slow scan worker's timer chain
    scanWorkerInstance?.terminate()
    resetMockWorkers()
    useSlowScanWorker = false
    scanWorkerInstance = undefined

    configureMockMappingWorkers(Array(WORKER_COUNT).fill('normal'))

    // Second run: should complete normally with clean state
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

  it('abort during crash recovery — no zombie replacement workers', async () => {
    // Configure one crash worker at the end (LIFO: it receives first file)
    const behaviors: MockWorkerBehavior[] = [
      ...Array(WORKER_COUNT - 1).fill('normal' as MockWorkerBehavior),
      'crash-onerror',
    ]
    configureMockMappingWorkers(behaviors)

    const controller = new AbortController()

    let progressCount = 0
    let aborted = false

    try {
      await curateMany(
        {
          inputType: 'path',
          inputDirectory: testDir,
          curationSpec: minimalSpec,
          skipWrite: true,
          workerCount: WORKER_COUNT,
          signal: controller.signal,
        },
        () => {
          progressCount++
          // Abort shortly after the crash worker has received its file
          // and crash recovery is likely in progress
          if (progressCount >= 1 && !aborted) {
            aborted = true
            controller.abort()
          }
        },
      )
      expect(true).toBe(false)
    } catch (error: any) {
      expect(error.name).toBe('AbortError')
    }

    // Give the async replacement worker creation chain time to settle.
    // The recoverCrashedWorker spawns a replacement asynchronously — we need
    // the .then() callback (which terminates the zombie) to execute.
    await new Promise((r) => setTimeout(r, 50))

    // All initially created mapping workers should be terminated
    const allWorkers = getMockWorkersCreated()
    for (const worker of allWorkers) {
      expect(worker.terminated).toBe(true)
    }

    // Now run again to verify no zombie state
    scanWorkerInstance?.terminate()
    resetMockWorkers()
    scanWorkerInstance = undefined
    useSlowScanWorker = false

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
  })
})
