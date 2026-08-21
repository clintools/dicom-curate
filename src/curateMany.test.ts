import type { MockedFunction } from 'vitest'

async function flushAsyncSetup() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** Longer form, for setups that await a worker creation part way through. */
async function flushTicks(rounds = 30) {
  for (let tick = 0; tick < rounds; tick++) {
    await Promise.resolve()
  }
}

/**
 * Scan worker stand-in: only the surface initializeFileListWorker touches.
 * Deliberately has no `on`, so the Node-only 'exit' wiring is skipped.
 */
function makeMockScanWorker() {
  const messageListeners: ((event: { data: unknown }) => void)[] = []
  return {
    onerror: null as ((event: unknown) => void) | null,
    terminate: vi.fn(),
    postMessage: vi.fn(),
    addEventListener: vi.fn((event: string, listener: any) => {
      if (event === 'message') messageListeners.push(listener)
    }),
    emitMessage(data: unknown) {
      for (const listener of messageListeners) listener({ data })
    },
  }
}
describe('curateMany', () => {
  let curateMany: typeof import('./index').curateMany
  let mappingWorkerPool: typeof import('./mappingWorkerPool')
  let composeSpecsModule: typeof import('./composeSpecs')
  let workerModule: typeof import('./worker')

  let capturedProgressCallback: ((msg: any) => void) | undefined

  function emitDone(result: Record<string, unknown> = {}) {
    if (!capturedProgressCallback) {
      throw new Error('Progress callback was not captured')
    }

    capturedProgressCallback({
      response: 'done',
      fileCount: 1,
      fileErrors: 0,
      warnings: [],
      elapsedSeconds: 0,
      ...result,
    })
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    capturedProgressCallback = undefined

    vi.doMock('./mappingWorkerPool', () => ({
      availableMappingWorkers: [],
      dispatchMappingJobs: vi.fn(),
      filesToProcess: [],
      getLastMappingProgressTime: vi.fn(() => Date.now()),
      getLastScanProgressTime: vi.fn(() => Date.now()),
      getPendingReplacements: vi.fn(() => 0),
      getWorkerCurrentFile: vi.fn(() => new Map()),
      getWorkersActive: vi.fn(() => 0),
      initializeMappingWorkers: vi.fn(
        async (
          _skipCollectingMappings: unknown,
          _fileInfoIndex: unknown,
          progressCallback: (msg: any) => void,
        ) => {
          capturedProgressCallback = progressCallback
        },
      ),
      isDirectoryScanFinished: vi.fn(() => true),
      markScanPaused: vi.fn(),
      resetProgressTimestamps: vi.fn(),
      resetScanProgressTime: vi.fn(),
      scanAnomalies: [],
      setDirectoryScanFinished: vi.fn(),
      setAbortSignal: vi.fn(),
      setCustomUploader: vi.fn(),
      setMappingWorkerOptions: vi.fn(),
      setScanResumeCallback: vi.fn(),
      setTotalDiscoveredFiles: vi.fn(),
      terminateAllWorkers: vi.fn(),
    }))

    vi.doMock('./composeSpecs', () => ({
      composeSpecs: vi.fn(() => ({
        dicomPS315EOptions: 'Off',
      })),
    }))

    vi.doMock('./worker', () => ({
      createWorker: vi.fn(),
    }))

    mappingWorkerPool = await import('./mappingWorkerPool')
    composeSpecsModule = await import('./composeSpecs')
    workerModule = await import('./worker')
    ;({ curateMany } = await import('./index'))
  })

  it('rejects immediately for a pre-aborted signal and does not start worker initialization', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
        signal: controller.signal,
      } as any),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(mappingWorkerPool.initializeMappingWorkers).not.toHaveBeenCalled()
    expect(mappingWorkerPool.terminateAllWorkers).not.toHaveBeenCalled()
  })

  it('rejects when initializeMappingWorkers fails inside the async IIFE', async () => {
    ;(
      mappingWorkerPool.initializeMappingWorkers as MockedFunction<
        typeof mappingWorkerPool.initializeMappingWorkers
      >
    ).mockRejectedValueOnce(new Error('init failed'))

    await expect(
      curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
      } as any),
    ).rejects.toThrow('init failed')

    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1)
    expect(mappingWorkerPool.setMappingWorkerOptions).not.toHaveBeenCalled()
  })

  it('rejects when collectMappingOptions throws inside the async IIFE', async () => {
    ;(
      composeSpecsModule.composeSpecs as MockedFunction<
        typeof composeSpecsModule.composeSpecs
      >
    ).mockReturnValueOnce({
      dicomPS315EOptions: {
        retainLongitudinalTemporalInformationOptions: 'Offset',
      },
    } as any)

    await expect(
      curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: () => ({}),
        dateOffset: 'not-an-iso8601-offset',
      } as any),
    ).rejects.toThrow(
      'When using "Offset" for retainLongitudinalTemporalInformationOptions',
    )

    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1)
    expect(mappingWorkerPool.setMappingWorkerOptions).not.toHaveBeenCalled()
    expect(mappingWorkerPool.dispatchMappingJobs).not.toHaveBeenCalled()
  })

  it('rejects when a summary spec (additionalData.output) runs without skipWrite', async () => {
    ;(
      composeSpecsModule.composeSpecs as MockedFunction<
        typeof composeSpecsModule.composeSpecs
      >
    ).mockReturnValueOnce({
      dicomPS315EOptions: 'Off',
      additionalData: {
        type: 'listing',
        collect: () => ({ lookups: {}, info: [], collect: [] }),
        output: { path: 'reports/summary.csv', rowKey: 'PerSeries' },
      },
    } as any)

    await expect(
      curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: () => ({}),
        // skipWrite omitted -> defaults to false -> must reject
      } as any),
    ).rejects.toThrow(
      'additionalData.output (summary-table mode) requires skipWrite: true',
    )

    expect(mappingWorkerPool.setMappingWorkerOptions).not.toHaveBeenCalled()
    expect(mappingWorkerPool.dispatchMappingJobs).not.toHaveBeenCalled()
  })

  it('accepts a summary spec (additionalData.output) when skipWrite is true', async () => {
    ;(
      composeSpecsModule.composeSpecs as MockedFunction<
        typeof composeSpecsModule.composeSpecs
      >
    ).mockReturnValue({
      dicomPS315EOptions: 'Off',
      additionalData: {
        type: 'listing',
        collect: () => ({ lookups: {}, info: [], collect: [] }),
        output: { path: 'reports/summary.csv', rowKey: 'PerSeries' },
      },
    } as any)

    const promise = curateMany({
      inputType: 'http',
      inputUrls: ['https://example.com/file.dcm'],
      curationSpec: () => ({}),
      skipWrite: true,
    } as any)

    await flushAsyncSetup()
    emitDone()
    await expect(promise).resolves.toBeDefined()

    expect(mappingWorkerPool.setMappingWorkerOptions).toHaveBeenCalled()
  })

  it('rejects with AbortError if aborted while async setup is still in progress', async () => {
    let resolveInit!: () => void
    ;(
      mappingWorkerPool.initializeMappingWorkers as MockedFunction<
        typeof mappingWorkerPool.initializeMappingWorkers
      >
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve
        }),
    )

    const controller = new AbortController()

    const promise = curateMany({
      inputType: 'http',
      inputUrls: ['https://example.com/file.dcm'],
      curationSpec: 'none',
      signal: controller.signal,
    } as any)

    controller.abort()

    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(mappingWorkerPool.terminateAllWorkers).toHaveBeenCalledTimes(1)

    resolveInit()
    await Promise.resolve()
  })

  it('resolves on the happy path for http input', async () => {
    const promise = curateMany({
      inputType: 'http',
      inputUrls: [
        'https://example.com/file1.dcm',
        'https://example.com/file2.dcm',
      ],
      curationSpec: 'none',
    } as any)

    await flushAsyncSetup()

    emitDone({
      fileCount: 2,
      elapsedSeconds: 1,
    })

    const result = await promise

    expect(result).toMatchObject({
      response: 'done',
      fileCount: 2,
      elapsedSeconds: 1,
    })
    expect(mappingWorkerPool.initializeMappingWorkers).toHaveBeenCalledTimes(1)
    expect(mappingWorkerPool.setMappingWorkerOptions).toHaveBeenCalledTimes(1)
    expect(mappingWorkerPool.dispatchMappingJobs).toHaveBeenCalled()
    expect(mappingWorkerPool.setDirectoryScanFinished).toHaveBeenCalledWith(
      true,
    )
    expect(mappingWorkerPool.filesToProcess).toHaveLength(2)
  })

  it('resolves on the happy path for files input', async () => {
    const promise = curateMany({
      inputType: 'files',
      inputFiles: [new File(['a'], 'file1.dcm'), new File(['b'], 'file2.dcm')],
      curationSpec: 'none',
    } as any)

    await flushAsyncSetup()

    emitDone({ fileCount: 2 })

    await expect(promise).resolves.toMatchObject({ response: 'done' })

    expect(mappingWorkerPool.filesToProcess).toHaveLength(2)
    // Nothing scans for this input type, so this is the only thing that can
    // make the termination condition reachable.
    expect(mappingWorkerPool.setDirectoryScanFinished).toHaveBeenCalledWith(
      true,
    )
  })

  it('forwards progress messages to the caller before resolving', async () => {
    const onProgress = vi.fn()

    const promise = curateMany(
      {
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
      } as any,
      onProgress,
    )

    await Promise.resolve()

    if (!capturedProgressCallback) {
      throw new Error('Progress callback was not captured')
    }

    capturedProgressCallback({
      response: 'progress',
      completedFileCount: 1,
      totalFileCount: 1,
      currentFile: 'file.dcm',
    })

    emitDone({
      fileCount: 1,
      elapsedSeconds: 1,
    })

    await expect(promise).resolves.toMatchObject({
      response: 'done',
      fileCount: 1,
    })

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'progress' }),
    )
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'done' }),
    )
  })

  it('resolves when the caller throws from the done callback', async () => {
    const onProgress = vi.fn(() => {
      throw new Error('consumer callback exploded')
    })

    const promise = curateMany(
      {
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
      } as any,
      onProgress,
    )

    await flushAsyncSetup()

    // The pool calls this synchronously from its termination block, so a throw
    // that escapes here would take the pump down with it.
    expect(() => emitDone({ fileCount: 1 })).not.toThrow()

    await expect(promise).resolves.toMatchObject({
      response: 'done',
      fileCount: 1,
    })
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('keeps the stall watchdog armed while a replacement worker is pending', async () => {
    vi.useFakeTimers()
    try {
      // Idle in every respect the watchdog checks except the one that matters:
      // a replacement is still being created, so the run is not finished.
      const pool = mappingWorkerPool as unknown as Record<
        string,
        MockedFunction<() => number | boolean>
      >
      pool.getLastMappingProgressTime.mockReturnValue(0)
      pool.getLastScanProgressTime.mockReturnValue(0)
      pool.getWorkersActive.mockReturnValue(0)
      pool.isDirectoryScanFinished.mockReturnValue(true)
      pool.getPendingReplacements.mockReturnValue(1)

      const controller = new AbortController()
      const promise = curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
        signal: controller.signal,
      } as any)

      await flushAsyncSetup()
      // Drain the URL queued at setup: the watchdog reads the live queue, and
      // this scenario needs it empty.
      mappingWorkerPool.filesToProcess.length = 0
      const dispatchesBeforeTick = (
        mappingWorkerPool.dispatchMappingJobs as MockedFunction<
          typeof mappingWorkerPool.dispatchMappingJobs
        >
      ).mock.calls.length

      vi.advanceTimersByTime(60_000)

      // Re-pumped rather than written off as a completed run.
      expect(mappingWorkerPool.dispatchMappingJobs).toHaveBeenCalledTimes(
        dispatchesBeforeTick + 1,
      )

      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a genuinely finished run as no stall', async () => {
    vi.useFakeTimers()
    try {
      const pool = mappingWorkerPool as unknown as Record<
        string,
        MockedFunction<() => number | boolean>
      >
      pool.getLastMappingProgressTime.mockReturnValue(0)
      pool.getLastScanProgressTime.mockReturnValue(0)
      pool.getWorkersActive.mockReturnValue(0)
      pool.isDirectoryScanFinished.mockReturnValue(true)
      pool.getPendingReplacements.mockReturnValue(0)

      const controller = new AbortController()
      const promise = curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
        signal: controller.signal,
      } as any)

      await flushAsyncSetup()
      // Drain the URL queued at setup: the watchdog reads the live queue, and
      // a genuinely finished run has it empty.
      mappingWorkerPool.filesToProcess.length = 0
      const dispatchesBeforeTick = (
        mappingWorkerPool.dispatchMappingJobs as MockedFunction<
          typeof mappingWorkerPool.dispatchMappingJobs
        >
      ).mock.calls.length

      vi.advanceTimersByTime(60_000)

      expect(mappingWorkerPool.dispatchMappingJobs).toHaveBeenCalledTimes(
        dispatchesBeforeTick,
      )

      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards done to the caller at most once', async () => {
    const onProgress = vi.fn()

    const promise = curateMany(
      {
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: 'none',
      } as any,
      onProgress,
    )

    await flushAsyncSetup()

    emitDone({ fileCount: 1 })
    emitDone({ fileCount: 99 })

    await expect(promise).resolves.toMatchObject({ fileCount: 1 })

    const doneCalls = onProgress.mock.calls.filter(
      ([msg]) => msg.response === 'done',
    )
    expect(doneCalls).toHaveLength(1)
  })

  it('terminates the mapping pool when setup throws after the pool is built', async () => {
    ;(
      composeSpecsModule.composeSpecs as MockedFunction<
        typeof composeSpecsModule.composeSpecs
      >
    ).mockReturnValueOnce({
      dicomPS315EOptions: {
        retainLongitudinalTemporalInformationOptions: 'Offset',
      },
    } as any)

    await expect(
      curateMany({
        inputType: 'http',
        inputUrls: ['https://example.com/file.dcm'],
        curationSpec: () => ({}),
        dateOffset: 'not-an-iso8601-offset',
      } as any),
    ).rejects.toThrow(
      'When using "Offset" for retainLongitudinalTemporalInformationOptions',
    )

    expect(mappingWorkerPool.terminateAllWorkers).toHaveBeenCalledTimes(1)
  })

  // Both teardown paths terminate fileListWorker, and both see it as undefined
  // until the assignment completes, so a run that settles during creation has
  // nothing left able to stop the scan worker.
  it('terminates a scan worker created for a run that settled during its creation', async () => {
    const scanWorker = makeMockScanWorker()
    let resolveCreate: ((worker: unknown) => void) | undefined
    ;(
      workerModule.createWorker as MockedFunction<
        typeof workerModule.createWorker
      >
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve as (worker: unknown) => void
        }),
    )

    const controller = new AbortController()
    const promise = curateMany({
      inputType: 'path',
      inputDirectory: '/tmp/curate-many-test',
      curationSpec: 'none',
      signal: controller.signal,
    } as any)

    await flushTicks()
    expect(resolveCreate).toBeDefined()

    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    // The worker only exists now: after the run settled, and after both
    // teardown paths ran and found nothing to terminate.
    resolveCreate!(scanWorker)
    await flushTicks()

    expect(scanWorker.terminate).toHaveBeenCalledTimes(1)
    // A scan request from here walks the whole input tree for a dead run and
    // holds the Node event loop open with nothing able to stop it.
    expect(scanWorker.postMessage).not.toHaveBeenCalled()
  })

  // A late event from a finished run's scanner reaches whatever is in the
  // module-global pool by then -- possibly a later run's idle workers.
  it("leaves the mapping pool alone when a settled run's scanner reports late", async () => {
    const scanWorker = makeMockScanWorker()
    ;(
      workerModule.createWorker as MockedFunction<
        typeof workerModule.createWorker
      >
    ).mockResolvedValueOnce(scanWorker as unknown as Worker)

    const promise = curateMany({
      inputType: 'path',
      inputDirectory: '/tmp/curate-many-test',
      curationSpec: 'none',
    } as any)

    await flushTicks()
    emitDone()
    await expect(promise).resolves.toBeDefined()

    // Stands in for the idle pool of whichever run is current by then.
    const laterRunWorker = { terminate: vi.fn() }
    mappingWorkerPool.availableMappingWorkers.push(
      laterRunWorker as unknown as Worker,
    )

    scanWorker.onerror!({ message: 'Scan worker crashed' })
    scanWorker.emitMessage({ response: 'error', error: 'Scan worker error' })

    expect(laterRunWorker.terminate).not.toHaveBeenCalled()
    // failRun is settled-guarded.
    expect(mappingWorkerPool.terminateAllWorkers).not.toHaveBeenCalled()
  })

  // The watchdog's no-mapping-work branch also holds during start-up and
  // permanently for an inputType that starts no scanner. Settling such a run is
  // right, but naming a component that never ran misdirects the operator.
  it('does not blame the scan worker when no scan was ever started', async () => {
    vi.useFakeTimers()
    try {
      const pool = mappingWorkerPool as unknown as Record<
        string,
        MockedFunction<() => number | boolean>
      >
      pool.getLastMappingProgressTime.mockReturnValue(0)
      pool.getLastScanProgressTime.mockReturnValue(0)
      pool.getWorkersActive.mockReturnValue(0)
      pool.isDirectoryScanFinished.mockReturnValue(false)
      pool.getPendingReplacements.mockReturnValue(0)

      const promise = curateMany({
        inputType: 'not-a-supported-input-type',
        curationSpec: 'none',
      } as any)

      await flushTicks()
      vi.advanceTimersByTime(60_000)

      await expect(promise).rejects.toThrow(
        'No mapping work and no directory scan in progress for 10 minutes',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('still blames the scan worker once a scan has actually been requested', async () => {
    const scanWorker = makeMockScanWorker()
    ;(
      workerModule.createWorker as MockedFunction<
        typeof workerModule.createWorker
      >
    ).mockResolvedValueOnce(scanWorker as unknown as Worker)

    vi.useFakeTimers()
    try {
      const pool = mappingWorkerPool as unknown as Record<
        string,
        MockedFunction<() => number | boolean>
      >
      pool.getLastMappingProgressTime.mockReturnValue(0)
      pool.getLastScanProgressTime.mockReturnValue(0)
      pool.getWorkersActive.mockReturnValue(0)
      pool.isDirectoryScanFinished.mockReturnValue(false)
      pool.getPendingReplacements.mockReturnValue(0)

      const promise = curateMany({
        inputType: 'path',
        inputDirectory: '/tmp/curate-many-test',
        curationSpec: 'none',
      } as any)

      await flushTicks()
      expect(scanWorker.postMessage).toHaveBeenCalled()

      vi.advanceTimersByTime(60_000)

      await expect(promise).rejects.toThrow(
        'Scan worker stopped reporting progress for 10 minutes',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
