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

vi.doMock('./httpHeaders', () => ({
  getHttpInputHeaders: vi.fn(async (fileInfo: any) => {
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
    resetMockWorkers()
  })

  afterEach(() => {
    // Unblock any pending header awaits so the event loop is clean.
    resumeHeaders?.()
    resumeHeaders = null
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
