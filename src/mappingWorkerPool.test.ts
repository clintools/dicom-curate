import {
  configureMockMappingWorkers,
  getMockWorkersCreated,
  getNextMockBehavior,
  MockWorker,
  registerMockWorker,
  resetMockWorkers,
} from '../testutils/mockMappingWorker'

let pauseHeaders = false
let resumeHeaders: (() => void) | null = null
let failPausedHeaders: (() => void) | null = null
let rejectNextHeaders = false
let rejectAllHeaders = false
let failWorkerCreation = false

vi.doMock('./httpHeaders', () => ({
  getHttpInputHeaders: vi.fn(async (fileInfo: any) => {
    if (rejectAllHeaders) {
      throw new Error('Header provider unavailable')
    }
    if (rejectNextHeaders) {
      rejectNextHeaders = false
      throw new Error('Header provider unavailable')
    }
    if (pauseHeaders) {
      await new Promise<void>((resolve, reject) => {
        resumeHeaders = resolve
        failPausedHeaders = () =>
          reject(new Error('Header provider unavailable'))
      })
    }
    return fileInfo
  }),
  getHttpOutputHeaders: vi.fn(async (x: any) => x),
}))

vi.doMock('./worker', () => ({
  createWorker: vi.fn(async () => {
    if (failWorkerCreation) {
      throw new Error('Worker construction failed')
    }
    const mock = new MockWorker(getNextMockBehavior())
    registerMockWorker(mock)
    return mock as unknown as Worker
  }),
  fixupNodeWorkerEnvironment: vi.fn(async () => {}),
}))

const pool = await import('./mappingWorkerPool')

function makeFileInfo(name: string): any {
  return { kind: 'file', path: '/', name }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** Let any already-scheduled setTimeout(0) work run to completion. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Drive real timers until `predicate` holds; the mock workers reply on setTimeout(0). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('waitFor: condition was never met')
}

function queueFile(name: string) {
  return { fileInfo: makeFileInfo(name), scanAnomalies: [] }
}

describe('dispatchMappingJobs', () => {
  beforeEach(() => {
    pauseHeaders = false
    resumeHeaders = null
    failPausedHeaders = null
    rejectNextHeaders = false
    rejectAllHeaders = false
    failWorkerCreation = false
    resetMockWorkers()
  })

  afterEach(() => {
    // Unblock any pending header awaits so the event loop is clean.
    resumeHeaders?.()
    resumeHeaders = null
    // availableMappingWorkers is module-global and initializeMappingWorkers
    // only pushes to it, so a worker one test leaves behind is dispatchable in
    // the next.
    pool.terminateAllWorkers()
  })

  it('increments workersActive before yielding for header resolution, preventing premature done', async () => {
    // One 'hang' worker: it receives the postMessage but never calls back,
    // so workersActive stays > 0 for the duration of the test.
    pauseHeaders = true
    configureMockMappingWorkers(['hang'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      true,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    pool.filesToProcess.push({
      fileInfo: makeFileInfo('a.dcm'),
      scanAnomalies: [],
    })

    // Start dispatch; it will increment workersActive then pause at the await.
    const dispatchPromise = pool.dispatchMappingJobs()

    // Let the event loop run up to the first await inside dispatchMappingJobs.
    await flushMicrotasks()

    // workersActive must already be 1: the increment was moved before the await.
    // If the bug were reintroduced (increment after the await), this would be 0.
    expect(pool.getWorkersActive()).toBe(1)

    // Simulate a concurrent dispatchMappingJobs() call, as triggered when a
    // previously-dispatched worker sends its 'finished' message. The queue is
    // now empty, scan is done, but workersActive > 0, so 'done' must NOT fire.
    await pool.dispatchMappingJobs()

    expect(progressMessages).not.toContainEqual(
      expect.objectContaining({ response: 'done' }),
    )

    // Unblock header resolution so the first dispatch can finish cleanly.
    resumeHeaders?.()
    await dispatchPromise
  })

  it('keeps pumping when the consumer progress callback throws', async () => {
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      true,
      undefined,
      (msg: any) => {
        progressMessages.push(msg)
        throw new Error('consumer callback exploded')
      },
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    pool.filesToProcess.push(queueFile('a.dcm'), queueFile('b.dcm'))

    // The throw must not escape dispatch either: every caller invokes
    // dispatchMappingJobs() unawaited, so a rejection would go unhandled.
    await expect(pool.dispatchMappingJobs()).resolves.toBeUndefined()

    await waitFor(() => progressMessages.some((m) => m.response === 'done'))

    // Both files reported and the run finished: without the guard the first
    // 'finished' would kill the pump with the second file still queued.
    expect(
      progressMessages.filter((m) => m.response === 'progress'),
    ).toHaveLength(2)
    expect(progressMessages.at(-1).processedFiles).toBe(2)
    expect(pool.getWorkersActive()).toBe(0)
  })

  it('errors the file and returns the worker when header resolution rejects', async () => {
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    // LIFO dispatch: the last file pushed is the one whose headers reject.
    pool.filesToProcess.push(queueFile('mapped.dcm'), queueFile('rejected.dcm'))
    rejectNextHeaders = true

    await pool.dispatchMappingJobs()
    await waitFor(() => progressMessages.some((m) => m.response === 'done'))

    const done = progressMessages.at(-1)
    expect(done.processedFiles).toBe(2)

    // The popped file is accounted for as an error carrying its fileInfo,
    // rather than disappearing along with the worker slot.
    const failed = done.mapResultsList.find(
      (r: any) => r.fileInfo?.name === 'rejected.dcm',
    )
    expect(failed.errors).toEqual(['Header provider unavailable'])

    // The second file could only be dispatched because the worker went back
    // to the pool, so this is the assertion that the slot was not leaked.
    const mapped = done.mapResultsList.find(
      (r: any) => r.fileInfo?.name === 'mapped.dcm',
    )
    expect(mapped.errors).toEqual([])
    expect(pool.getWorkersActive()).toBe(0)
  })

  it('fails the run once dispatch has failed for a long enough streak', async () => {
    // getHttpOutputHeaders runs per file, so one expired token fails every
    // file in turn. Erroring each of them keeps 'done' reachable but turns a
    // systemic failure into a successful run full of errors, which reads the
    // same as a genuine mass failure -- so the pool reports it upward.
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    const rejections: Error[] = []
    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
      // What the run owner does with the report: the teardown is what stops
      // the loop, so the file count below is the damage a streak really does.
      (reason: Error) => {
        rejections.push(reason)
        pool.terminateAllWorkers()
      },
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    for (let i = 0; i < 200; i++) {
      pool.filesToProcess.push(queueFile(`f${i}.dcm`))
    }

    // The streak is timed off the same clock as the retry delays, so under
    // fake timers the delays are what age it into a report.
    vi.useFakeTimers()
    try {
      const dispatchPromise = pool.dispatchMappingJobs()
      await vi.advanceTimersByTimeAsync(30_000)
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }

    // Once per streak, not once per failed file: the run owner tears the pool
    // down on the first report, and a success would reset the count.
    expect(rejections).toHaveLength(1)
    expect(rejections[0].message).toMatch(
      /Dispatch failed for 2\d+ consecutive/,
    )
    // The point of the retry delay: a 200-file queue loses about twenty files,
    // not all of them, before the run is failed.
    expect(progressMessages.length).toBeLessThanOrEqual(25)
    expect(pool.filesToProcess).toHaveLength(0)
  })

  // A token refresh that blips for a few seconds fails a burst of files. The
  // provider comes back before the streak is old enough to count, and tearing
  // the whole run down over it would cost hours of completed work.
  it('does not fail the run when a failure burst is over quickly', async () => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    const rejections: Error[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      () => {},
      1,
      (reason: Error) => rejections.push(reason),
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    for (let i = 0; i < 40; i++) {
      pool.filesToProcess.push(queueFile(`f${i}.dcm`))
    }

    vi.useFakeTimers()
    try {
      const dispatchPromise = pool.dispatchMappingJobs()
      await vi.advanceTimersByTimeAsync(4_000)
      rejectAllHeaders = false
      await vi.advanceTimersByTimeAsync(4_000)
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }

    expect(rejections).toEqual([])
  })

  it('does not report a streak when dispatches succeed in between', async () => {
    configureMockMappingWorkers(['normal'])

    const rejections: Error[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      () => {},
      1,
      (reason: Error) => rejections.push(reason),
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    // Left unfinished: with the scan complete the first good file empties the
    // queue, which emits 'done' and drains the pool, and every later pair is
    // then a no-op that proves nothing.
    pool.setDirectoryScanFinished(false)

    // Individually bad files, each followed by a good one: the count resets,
    // so a run with scattered failures still completes. More pairs than
    // MAX_CONSECUTIVE_DISPATCH_FAILURES, so an unreset count would report.
    // Fake timers because each failure costs a retry delay.
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 25; i++) {
        rejectNextHeaders = true
        pool.filesToProcess.push(queueFile(`bad${i}.dcm`))
        const failing = pool.dispatchMappingJobs()
        await vi.advanceTimersByTimeAsync(1_000)
        await failing
        pool.filesToProcess.push(queueFile(`good${i}.dcm`))
        const succeeding = pool.dispatchMappingJobs()
        await vi.advanceTimersByTimeAsync(1_000)
        await succeeding
      }
    } finally {
      vi.useRealTimers()
    }

    expect(rejections).toHaveLength(0)
  })

  // recoverCrashedWorker ignores a worker holding no file, so without a path
  // of its own the offender stays in the pool and is handed the next file.
  it('drops an idle worker that breaks the protocol and replaces it', async () => {
    configureMockMappingWorkers(['unknown-response-idle'])

    await pool.initializeMappingWorkers(false, undefined, () => {}, 1)
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    // Left unfinished so the termination block cannot drain the pool instead.
    pool.setDirectoryScanFinished(false)

    const offender = getMockWorkersCreated()[0]
    await waitFor(() => offender.terminated)
    await settle()

    expect(pool.availableMappingWorkers).toHaveLength(1)
    expect(pool.availableMappingWorkers[0]).not.toBe(
      offender as unknown as Worker,
    )
    expect(pool.getPendingReplacements()).toBe(0)
  })

  // An OOM kill takes the worker and the memory to build another. With no
  // worker left, dispatch can never run and the queue can never drain, so the
  // run has to be told rather than left waiting on work that cannot happen.
  it('fails the run when the last worker cannot be replaced', async () => {
    configureMockMappingWorkers(['crash-onerror'])

    const rejections: Error[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      () => {},
      1,
      (reason: Error) => rejections.push(reason),
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(queueFile('a.dcm'), queueFile('b.dcm'))

    failWorkerCreation = true
    await pool.dispatchMappingJobs()
    await waitFor(() => rejections.length > 0)

    expect(rejections[0].message).toMatch(/No mapping workers left/)
    expect(pool.availableMappingWorkers).toHaveLength(0)
  })

  it('does not free a still-busy worker on an unrecognised message', async () => {
    // The mock replies with an unknown message and then finishes the file, so
    // returning the worker to the pool would count that file twice and drive
    // workersActive negative -- past which the termination check never holds.
    configureMockMappingWorkers(['unknown-response'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    // Scan deliberately left unfinished: reaching 'done' would terminate the
    // pooled worker and mask the late reply this guards against.
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(queueFile('a.dcm'))

    await pool.dispatchMappingJobs()
    await waitFor(() => progressMessages.length > 0)
    await settle()

    // One file in, one result out: a second means the worker replied after
    // being freed.
    expect(progressMessages).toHaveLength(1)
    expect(progressMessages[0].processedFiles).toBe(1)
    expect(pool.getWorkersActive()).toBe(0)
    // The replacement, not the original returned twice.
    expect(pool.availableMappingWorkers).toHaveLength(1)
  })

  it('reports whether the scan has finished on every progress message', async () => {
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(queueFile('a.dcm'))

    await pool.dispatchMappingJobs()
    await waitFor(() => progressMessages.length > 0)

    // Still scanning: totalFiles is a lower bound, which is what a consumer
    // needs to know before rendering it as a percentage.
    expect(progressMessages[0].scanComplete).toBe(false)

    pool.setDirectoryScanFinished(true)
    pool.filesToProcess.push(queueFile('b.dcm'))
    await pool.dispatchMappingJobs()
    await waitFor(() => progressMessages.some((m) => m.response === 'done'))

    expect(progressMessages[1].scanComplete).toBe(true)
    expect(progressMessages.at(-1)).toMatchObject({
      response: 'done',
      scanComplete: true,
    })
  })

  it('leaves the pool clean when the run is aborted during header resolution', async () => {
    pauseHeaders = true
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    pool.filesToProcess.push(queueFile('a.dcm'))

    const dispatchPromise = pool.dispatchMappingJobs()
    await flushMicrotasks()

    // Abort mid-await, then fail the header request as a cancelled provider
    // would. The pool is torn down by the time the rejection lands.
    pool.terminateAllWorkers()
    failPausedHeaders?.()
    await dispatchPromise

    // A terminated worker put back here would be handed a file by the *next*
    // run and never reply, and a negative count would break its termination.
    expect(pool.availableMappingWorkers).toHaveLength(0)
    expect(pool.getWorkersActive()).toBe(0)
    expect(progressMessages).toHaveLength(0)
  })

  it('does not re-account a file the stall watchdog already recovered', async () => {
    pauseHeaders = true
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    // Left unfinished so the run cannot terminate and tear the pool down
    // before the late rejection lands.
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(queueFile('a.dcm'))

    const dispatchPromise = pool.dispatchMappingJobs()
    await flushMicrotasks()

    // The watchdog reaches the worker through onerror while the dispatch loop
    // is still awaiting its headers -- the file is accounted for here.
    const [stuck] = getMockWorkersCreated()
    stuck.onerror!({ message: 'Worker stalled (no response for 10 minutes)' })
    await settle()

    // Only now does the header request fail, for the same underlying reason.
    failPausedHeaders?.()
    await dispatchPromise
    await settle()

    expect(progressMessages).toHaveLength(1)
    expect(progressMessages[0].processedFiles).toBe(1)
    expect(pool.getWorkersActive()).toBe(0)
    // The replacement only. The recovered worker was terminated, so putting it
    // back would hand the next dispatch a worker that can never reply.
    expect(pool.availableMappingWorkers).toHaveLength(1)
    expect(pool.availableMappingWorkers[0]).not.toBe(stuck)
  })

  it('emits done once when dispatch is re-entered in a terminal state', async () => {
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    pool.scanAnomalies.push({
      fileInfo: makeFileInfo('unreadable.dcm'),
      anomalies: [],
      errors: ['Simulated read failure'],
    })

    await pool.dispatchMappingJobs()
    await pool.dispatchMappingJobs()

    const doneMessages = progressMessages.filter((m) => m.response === 'done')
    expect(doneMessages).toHaveLength(1)
    // The consumer already holds this array, so a second pass through the
    // termination block would corrupt results it has already been given.
    expect(doneMessages[0].mapResultsList).toHaveLength(1)
  })
})

describe('initializeMappingWorkers', () => {
  beforeEach(() => {
    resetMockWorkers()
  })

  afterEach(() => {
    pool.terminateAllWorkers()
  })

  // An empty pool blames the workers for it: "All mapping workers failed to
  // initialize: " with nothing after the colon, none having been created.
  it('rejects a workerCount below one', async () => {
    configureMockMappingWorkers(['normal'])

    await expect(
      pool.initializeMappingWorkers(false, undefined, () => {}, 0),
    ).rejects.toThrow('workerCount must be a positive integer, received 0')
    expect(getMockWorkersCreated()).toHaveLength(0)
  })
})
