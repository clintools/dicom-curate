import {
  configureMockMappingWorkers,
  getNextMockBehavior,
  MockWorker,
  registerMockWorker,
  resetMockWorkers,
} from '../testutils/mockMappingWorker'

let pauseHeaders = false
let resumeHeaders: (() => void) | null = null

vi.doMock('./httpHeaders', () => ({
  getHttpInputHeaders: vi.fn(async (fileInfo: any) => {
    if (pauseHeaders) {
      await new Promise<void>((resolve) => {
        resumeHeaders = resolve
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

describe('dispatchMappingJobs', () => {
  beforeEach(() => {
    pauseHeaders = false
    resumeHeaders = null
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
})
