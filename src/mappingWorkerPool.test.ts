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
// Number of workers that may still be built before creation starts failing.
// null disables it; failWorkerCreation above is the all-or-nothing form.
let workerCreationsBeforeFailure: number | null = null
let pauseWorkerCreation = false
let resumeWorkerCreation: (() => void) | null = null

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
    if (workerCreationsBeforeFailure !== null) {
      if (workerCreationsBeforeFailure <= 0) {
        throw new Error('Worker construction failed')
      }
      workerCreationsBeforeFailure -= 1
    }
    if (pauseWorkerCreation) {
      await new Promise<void>((resolve) => {
        resumeWorkerCreation = resolve
      })
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

/**
 * The header and worker mocks are driven by file-scoped flags, so every
 * describe block has to clear them: whatever the previous test set otherwise
 * leaks into the next one, in a different block or not.
 */
function resetMockState(): void {
  pauseHeaders = false
  resumeHeaders = null
  failPausedHeaders = null
  rejectNextHeaders = false
  rejectAllHeaders = false
  failWorkerCreation = false
  workerCreationsBeforeFailure = null
  pauseWorkerCreation = false
  resumeWorkerCreation = null
  resetMockWorkers()
}

describe('dispatchMappingJobs', () => {
  beforeEach(resetMockState)

  afterEach(() => {
    // Unblock any pending header awaits so the event loop is clean.
    resumeHeaders?.()
    resumeHeaders = null
    // Same for a worker creation a test left parked.
    resumeWorkerCreation?.()
    resumeWorkerCreation = null
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

  // A run with a scattered handful of unreadable files must not pay for the
  // streak machinery: at a 5% failure rate a flat per-failure delay costs a
  // 100k-file run the best part of an hour in pure waiting.
  it('does not delay dispatch after an isolated failure', async () => {
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
    // LIFO dispatch: the last file pushed is the one whose headers reject, so
    // the good file behind it is dispatched from a live streak of one.
    pool.filesToProcess.push(queueFile('mapped.dcm'), queueFile('rejected.dcm'))
    rejectNextHeaders = true

    vi.useFakeTimers()
    try {
      // Not one tick of the clock: had the failure booked a backoff, the
      // second file could not be dispatched and this would never settle.
      await pool.dispatchMappingJobs()
    } finally {
      vi.useRealTimers()
    }

    expect(pool.filesToProcess).toHaveLength(0)
    expect(progressMessages).toHaveLength(1)
    expect(progressMessages[0].mapResults.errors).toEqual([
      'Header provider unavailable',
    ])
  })

  // The stall watchdog's only evidence that the mapping pump is alive. A pool
  // erroring files through the dispatch-failure path reaches none of the
  // handlers that refresh it, so without this it reads as dead and the watchdog
  // reports a stall against a pool that is working perfectly hard.
  it('counts a failed dispatch as mapping progress', async () => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    await pool.initializeMappingWorkers(false, undefined, () => {}, 1)
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(false)

    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      const before = pool.getLastMappingProgressTime()

      pool.filesToProcess.push(queueFile('bad.dcm'))
      void pool.dispatchMappingJobs()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(pool.getLastMappingProgressTime()).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
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
    // Captured before the teardown below empties it, so this measures the pool
    // and not the test's own reject callback.
    let queuedAtReport = -1
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
      // What the run owner does with the report: the teardown is what stops
      // the loop, so the file count below is the damage a streak really does.
      (reason: Error) => {
        rejections.push(reason)
        queuedAtReport = pool.filesToProcess.length
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
    expect(rejections[0].message).toMatch(/Dispatch failed for 2\d consecutive/)
    // The point of the backoff: a 200-file queue loses about twenty-five files,
    // not all of them, before the run is failed. Most of the queue is still
    // there when the report fires -- that is what makes the report worth acting
    // on rather than a postmortem.
    expect(progressMessages.length).toBeLessThanOrEqual(30)
    expect(queuedAtReport).toBeGreaterThan(150)
  })

  // dispatchMappingJobs() runs once per scan-worker message, twice for 'file',
  // so a streak during a live scan is re-entered continuously. Every entrant
  // has to defer, and only one of them may retry: a backoff that only slowed
  // the loop already sleeping lost 1051 files here instead of ~25, because each
  // new entrant found the failed worker already back in the pool.
  // Both counts, because the bound has to come from the streak and not from the
  // pool: letting every idle worker retry in lockstep would multiply the loss
  // by the pool size.
  it.each([
    1, 8,
  ])('bounds the loss when dispatch is re-entered throughout the streak (%i workers)', async (workerCount) => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    const rejections: Error[] = []
    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      workerCount,
      (reason: Error) => {
        rejections.push(reason)
        pool.terminateAllWorkers()
      },
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    for (let i = 0; i < 5000; i++) {
      pool.filesToProcess.push(queueFile(`f${i}.dcm`))
    }

    vi.useFakeTimers()
    try {
      void pool.dispatchMappingJobs()
      // A scanner feeding steadily: ten re-entries per 100ms for the whole
      // streak.
      for (let tick = 0; tick < 150; tick++) {
        for (let call = 0; call < 10; call++) void pool.dispatchMappingJobs()
        await vi.advanceTimersByTimeAsync(100)
      }
    } finally {
      vi.useRealTimers()
    }

    expect(rejections).toHaveLength(1)
    // 25 files at one worker, 29 at eight: the pool size adds a small
    // constant, because up to N attempts are already in flight before the
    // first failure registers, but it is not a multiplier. Unbounded, this
    // queue loses over a thousand.
    expect(progressMessages.length).toBeLessThanOrEqual(40)
    // The queue is never empty during the streak, so nothing may report the
    // run finished while the pool sits in a backoff with no worker active.
    expect(
      progressMessages.filter((m: any) => m.response === 'done'),
    ).toHaveLength(0)
  })

  // Reporting is advice, not teardown: rejectCb is optional, and the paths that
  // do wire it do not all terminate the pool. A backoff that switched itself
  // off once reported let the rest of the queue burn at full speed.
  it('keeps backing off after reporting when nothing tears the pool down', async () => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    const progressMessages: any[] = []
    // No rejectCb: the pool has nothing to report to and nothing tears it down.
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    for (let i = 0; i < 500; i++) {
      pool.filesToProcess.push(queueFile(`f${i}.dcm`))
    }

    vi.useFakeTimers()
    try {
      void pool.dispatchMappingJobs()
      // Well past the report, which lands around 10s.
      await vi.advanceTimersByTimeAsync(20_000)
    } finally {
      vi.useRealTimers()
    }

    // Capped by the backoff throughout, not just up to the report: 20s of
    // 500ms ceiling is ~45 files, nowhere near the whole queue.
    expect(progressMessages.length).toBeLessThanOrEqual(60)
    expect(pool.filesToProcess.length).toBeGreaterThan(400)
  })

  // A token refresh that blips for a few seconds fails a burst of files. The
  // provider comes back before the streak is old enough to count, and tearing
  // the whole run down over it would cost hours of completed work.
  //
  // The burst deliberately runs past MAX_CONSECUTIVE_DISPATCH_FAILURES: with
  // the count gate already satisfied, only the duration gate is left to stop
  // the report, which is the one this test exists to hold.
  it('does not fail the run when a failure burst is over quickly', async () => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    const rejections: Error[] = []
    const progressMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => progressMessages.push(msg),
      1,
      (reason: Error) => rejections.push(reason),
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(true)
    for (let i = 0; i < 60; i++) {
      pool.filesToProcess.push(queueFile(`f${i}.dcm`))
    }

    vi.useFakeTimers()
    try {
      const dispatchPromise = pool.dispatchMappingJobs()
      // Just under MIN_DISPATCH_FAILURE_STREAK_MS.
      await vi.advanceTimersByTimeAsync(9_000)
      rejectAllHeaders = false
      await vi.advanceTimersByTimeAsync(9_000)
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }

    expect(rejections).toEqual([])
    // Without this the burst could be short enough for the count gate to be
    // what held, and the duration gate would be free to disappear.
    const errored = progressMessages.filter(
      (m: any) => m.mapResults?.errors?.length,
    )
    expect(errored.length).toBeGreaterThan(20)
  })

  // Failures arriving more slowly than the backoff -- a queue the scanner is
  // only trickling into -- age past MIN_DISPATCH_FAILURE_STREAK_MS on their
  // own. Nothing but the count gate stands between two unlucky files eleven
  // seconds apart and a torn-down run.
  it('does not fail the run on a couple of failures spread over a long window', async () => {
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
    // Left unfinished so an empty queue does not emit 'done' and drain the pool
    // between the two failures.
    pool.setDirectoryScanFinished(false)

    vi.useFakeTimers()
    try {
      for (let i = 0; i < 2; i++) {
        rejectAllHeaders = true
        pool.filesToProcess.push(queueFile(`bad${i}.dcm`))
        await pool.dispatchMappingJobs()
        rejectAllHeaders = false
        // No successful dispatch in between, so the streak is never reset --
        // the second failure lands on a streak already older than
        // MIN_DISPATCH_FAILURE_STREAK_MS, leaving the count gate alone to
        // decide.
        await vi.advanceTimersByTimeAsync(11_000)
      }
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

  // The backoff gate sits between the while condition and the two pops, so
  // both loop invariants can go stale across its sleep. No abort is needed for
  // this one: a loop that entered before the streak began is not gated at all,
  // and can drain the queue while this one waits.
  it('recovers when the queue drains while dispatch sleeps in the backoff', async () => {
    rejectAllHeaders = true
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
    pool.filesToProcess.push(
      queueFile('a.dcm'),
      queueFile('b.dcm'),
      queueFile('c.dcm'),
    )

    vi.useFakeTimers()
    try {
      let dispatchError: unknown
      const parked = pool.dispatchMappingJobs().catch((error: unknown) => {
        dispatchError = error
      })

      // Two failures land: the first books no delay at all, and the second
      // parks the loop in a 50ms backoff with a file still queued.
      for (let tick = 0; tick < 5; tick++) {
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(progressMessages).toHaveLength(2)
      expect(pool.filesToProcess).toHaveLength(1)

      pool.filesToProcess.length = 0
      await vi.advanceTimersByTimeAsync(100)
      await parked

      // Popping an empty queue throws, and every caller of dispatchMappingJobs
      // invokes it unawaited -- on Node's default that is a process exit.
      expect(dispatchError).toBeUndefined()

      // A throw ahead of the try that releases the probe leaves it held by
      // nobody, and every later call then breaks at the gate -- including the
      // stall watchdog's recovery.
      rejectAllHeaders = false
      pool.filesToProcess.push(queueFile('d.dcm'))
      await pool.dispatchMappingJobs()
      await vi.advanceTimersByTimeAsync(100)

      expect(pool.filesToProcess).toHaveLength(0)
      expect(progressMessages).toHaveLength(3)
      expect(progressMessages[2].mapResults.errors).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // The same stale-invariant window, on the pool side: an idle worker can leave
  // the pool during the sleep with nothing put back in its place, which is
  // exactly what an idle 'initError' does by design.
  it('never pools an undefined worker when the pool empties during the backoff', async () => {
    rejectAllHeaders = true
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
    pool.filesToProcess.push(
      queueFile('a.dcm'),
      queueFile('b.dcm'),
      queueFile('c.dcm'),
    )

    vi.useFakeTimers()
    try {
      let dispatchError: unknown
      const parked = pool.dispatchMappingJobs().catch((error: unknown) => {
        dispatchError = error
      })
      for (let tick = 0; tick < 5; tick++) {
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(pool.availableMappingWorkers).toHaveLength(1)

      // The pooled worker reports that its environment never came up. That path
      // removes it and deliberately spawns no replacement, so the pool is empty
      // by the time the sleeping loop wakes.
      const [worker] = getMockWorkersCreated()
      ;(worker as any).emitMessage({
        response: 'initError',
        error: 'Simulated worker init failure',
      })
      expect(pool.availableMappingWorkers).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(100)
      await parked

      expect(dispatchError).toBeUndefined()
      // `undefined` popped from an empty pool is dispatchable, and
      // failFileAndReturnWorker puts it straight back after every failure.
      expect(pool.availableMappingWorkers).not.toContain(undefined)
      expect([...pool.getWorkerCurrentFile().keys()]).not.toContain(undefined)

      // Worse than a run full of error results: the termination block latches
      // doneEmitted before terminating the pool, so one throw on an `undefined`
      // entry puts 'done' permanently out of reach.
      pool.filesToProcess.length = 0
      pool.setDirectoryScanFinished(true)
      await pool.dispatchMappingJobs()
      expect(
        progressMessages.filter((m: any) => m.response === 'done'),
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // A teardown sets the abort flag and the next run clears it again. A loop
  // still sleeping in the backoff from the previous run wakes into that, with
  // every array it is about to touch now owned by a different run.
  it('does not let a dispatch loop that slept through a teardown serve the next run', async () => {
    rejectAllHeaders = true
    configureMockMappingWorkers(['normal'])

    await pool.initializeMappingWorkers(false, undefined, () => {}, 1)
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(
      queueFile('a.dcm'),
      queueFile('b.dcm'),
      queueFile('c.dcm'),
    )

    vi.useFakeTimers()
    try {
      let dispatchError: unknown
      const parked = pool.dispatchMappingJobs().catch((error: unknown) => {
        dispatchError = error
      })
      for (let tick = 0; tick < 5; tick++) {
        await vi.advanceTimersByTimeAsync(1)
      }

      pool.terminateAllWorkers()

      rejectAllHeaders = false
      const secondRunMessages: any[] = []
      await pool.initializeMappingWorkers(
        false,
        undefined,
        (msg: any) => secondRunMessages.push(msg),
        1,
      )
      pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
      pool.setDirectoryScanFinished(false)
      pool.filesToProcess.push(queueFile('second-run.dcm'))

      await vi.advanceTimersByTimeAsync(200)
      await parked

      expect(dispatchError).toBeUndefined()
      // The second run has dispatched nothing itself, so anything consumed here
      // was consumed by a loop that belongs to a run which is over.
      expect(pool.filesToProcess).toHaveLength(1)
      expect(secondRunMessages).toHaveLength(0)
      expect(pool.getWorkersActive()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // The replacement's own 'initError' can beat its continuation home, and
  // handleWorkerInitFailure cannot remove it from a pool it has not joined yet.
  it('keeps a replacement that already failed to initialize out of the pool', async () => {
    configureMockMappingWorkers(['crash-onerror', 'init-error-immediate'])

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
    pool.filesToProcess.push(queueFile('a.dcm'))

    await pool.dispatchMappingJobs()
    await waitFor(() => getMockWorkersCreated().length > 1)
    await settle()

    const replacement = getMockWorkersCreated()[1]
    expect(replacement.terminated).toBe(true)
    // postMessage to a terminated worker is a silent no-op, so a file handed to
    // this one sits unanswered until the ten-minute stall watchdog.
    expect(pool.availableMappingWorkers).not.toContain(
      replacement as unknown as Worker,
    )
    expect(pool.availableMappingWorkers).toHaveLength(0)
    expect(pool.getPendingReplacements()).toBe(0)
    // Nothing else can report it: handleWorkerInitFailure ran while this
    // replacement was still counted as pending, so it found the pool not empty.
    expect(rejections).toHaveLength(1)
    expect(rejections[0].message).toMatch(
      /All mapping workers failed to initialize/,
    )
  })

  // Both continuations of spawnReplacementWorker mutate module-global pool
  // state, and the module outlives the run. A replacement resolving after its
  // own run was torn down must leave the next run's counter alone: one stray
  // decrement puts its termination condition permanently out of reach.
  it('abandons a replacement whose run ended before it was created', async () => {
    configureMockMappingWorkers(['crash-onerror'])

    await pool.initializeMappingWorkers(false, undefined, () => {}, 1)
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    pool.setDirectoryScanFinished(false)
    pool.filesToProcess.push(queueFile('a.dcm'))

    pauseWorkerCreation = true
    await pool.dispatchMappingJobs()
    await waitFor(() => resumeWorkerCreation !== null)
    expect(pool.getPendingReplacements()).toBe(1)

    // Run one ends with that replacement still being built.
    pool.terminateAllWorkers()

    pauseWorkerCreation = false
    const secondRunMessages: any[] = []
    await pool.initializeMappingWorkers(
      false,
      undefined,
      (msg: any) => secondRunMessages.push(msg),
      1,
    )
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    const secondRunWorker = pool.availableMappingWorkers[0]

    // Only now does run one's replacement finish being created.
    resumeWorkerCreation!()
    resumeWorkerCreation = null
    await settle()

    expect(pool.getPendingReplacements()).toBe(0)
    expect(pool.availableMappingWorkers).toEqual([secondRunWorker])
    // Abandoned, not leaked: nothing else holds a reference to that thread.
    expect(getMockWorkersCreated().at(-1)!.terminated).toBe(true)

    // The counter is what proves it: at -1 the termination condition can never
    // hold and this run could never emit 'done'.
    pool.setDirectoryScanFinished(true)
    await pool.dispatchMappingJobs()
    expect(
      secondRunMessages.filter((m: any) => m.response === 'done'),
    ).toHaveLength(1)
  })

  /**
   * recoverCrashedWorker returns early for a worker holding no file, so neither
   * death signal does anything by itself for one that died idle. Without a path
   * of its own it stays in the pool, is handed the next file, and that file is
   * stuck until the ten-minute stall watchdog.
   */
  async function expectIdleDeathIsReplaced(
    kill: (worker: MockWorker) => void,
  ): Promise<void> {
    configureMockMappingWorkers(['normal'])

    await pool.initializeMappingWorkers(false, undefined, () => {}, 1)
    pool.setMappingWorkerOptions({ curationSpec: () => ({}) } as any)
    // Left unfinished so the termination block cannot drain the pool instead.
    pool.setDirectoryScanFinished(false)

    const dead = getMockWorkersCreated()[0]
    expect(pool.availableMappingWorkers).toEqual([dead as unknown as Worker])

    kill(dead)
    await waitFor(
      () =>
        pool.availableMappingWorkers.length === 1 &&
        pool.availableMappingWorkers[0] !== (dead as unknown as Worker),
    )
    await settle()

    expect(dead.terminated).toBe(true)
    expect(pool.getPendingReplacements()).toBe(0)

    // The replacement must also be able to take work.
    pool.filesToProcess.push(queueFile('a.dcm'))
    await pool.dispatchMappingJobs()
    await waitFor(() => pool.getWorkersActive() === 0)
    expect(pool.filesToProcess).toHaveLength(0)
  }

  it('replaces a pooled worker that dies while idle (onerror)', async () => {
    await expectIdleDeathIsReplaced((worker) => {
      worker.onerror!({ message: 'Simulated idle worker death' })
    })
  })

  it('replaces a pooled worker that dies while idle (non-zero exit)', async () => {
    await expectIdleDeathIsReplaced((worker) => {
      for (const listener of (worker as any).exitListeners) {
        listener(1)
      }
    })
  })

  // onerror and 'exit' can both fire for a single crash. The idle path above
  // must not turn the second of them into a second replacement, nor into a
  // second accounting of the file the first one already errored.
  it('spawns one replacement when a busy worker reports its crash twice', async () => {
    configureMockMappingWorkers(['crash-onerror-and-exit'])

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
    await settle()

    expect(getMockWorkersCreated()).toHaveLength(2)
    expect(pool.availableMappingWorkers).toHaveLength(1)
    expect(pool.getWorkersActive()).toBe(0)
    expect(progressMessages).toHaveLength(1)
  })
})

describe('initializeMappingWorkers', () => {
  beforeEach(resetMockState)

  afterEach(() => {
    pool.terminateAllWorkers()
  })

  // An empty pool blames the workers for it: "All mapping workers failed to
  // initialize: " with nothing after the colon, none having been created.
  it('rejects a workerCount below one', async () => {
    configureMockMappingWorkers(['normal'])

    await expect(
      pool.initializeMappingWorkers(false, undefined, () => {}, 0),
    ).rejects.toThrow(
      'workerCount must be an integer between 1 and 64, received 0',
    )
    expect(getMockWorkersCreated()).toHaveLength(0)
  })

  // The default path caps itself at 8; only an explicit count can ask for a
  // number of threads that exhausts the process before any work is done.
  it('rejects a workerCount above the ceiling', async () => {
    configureMockMappingWorkers(['normal'])

    await expect(
      pool.initializeMappingWorkers(false, undefined, () => {}, 100_000),
    ).rejects.toThrow(
      'workerCount must be an integer between 1 and 64, received 100000',
    )
    expect(getMockWorkersCreated()).toHaveLength(0)
  })

  // Promise.all rejects on the first failure and drops every worker it had
  // already built. Nothing else references them, so they can be neither used
  // nor terminated and hold the Node event loop open.
  it('terminates the workers it had already built when one cannot be created', async () => {
    configureMockMappingWorkers(['normal'])
    workerCreationsBeforeFailure = 4

    await expect(
      pool.initializeMappingWorkers(false, undefined, () => {}, 8),
    ).rejects.toThrow('Worker construction failed')

    const created = getMockWorkersCreated()
    expect(created).toHaveLength(4)
    expect(created.every((worker) => worker.terminated)).toBe(true)
    expect(pool.availableMappingWorkers).toHaveLength(0)
  })

  // getHardwareConcurrency falls back to os.cpus().length, which Node documents
  // as possibly empty. An unfloored default then builds an empty pool, which can
  // neither dispatch nor reach the termination condition.
  it('floors the default worker count when the host reports no CPUs', async () => {
    configureMockMappingWorkers(['normal'])
    // hardwareConcurrency is preferred when present, so the os fallback is only
    // reachable with no navigator at all.
    vi.stubGlobal('navigator', undefined)
    vi.doMock('node:os', () => ({ cpus: () => [] }))

    try {
      const rejections: Error[] = []
      await pool.initializeMappingWorkers(
        false,
        undefined,
        () => {},
        undefined,
        (reason: Error) => rejections.push(reason),
      )

      expect(pool.availableMappingWorkers).toHaveLength(1)
      expect(rejections).toHaveLength(0)
    } finally {
      vi.doUnmock('node:os')
      vi.unstubAllGlobals()
    }
  })
})
