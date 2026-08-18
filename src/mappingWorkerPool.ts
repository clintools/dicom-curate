/**
 * Mapping worker pool management.
 *
 * Manages the pool of web workers that apply curation mappings to DICOM files.
 * Handles worker creation, crash recovery, replacement spawning, dispatch, and
 * the stall watchdog. Extracted from index.ts for maintainability.
 */

import type {
  MappingRequest,
  UploadError,
  UploadResult,
} from './applyMappingsWorker'
import { safeSerializeError } from './applyMappingsWorker'
import { phiSafeToken } from './hash'
import { getHttpInputHeaders, getHttpOutputHeaders } from './httpHeaders'
import { serializeMappingOptions } from './serializeMappingOptions'
import type {
  TCustomUploader,
  TFileInfo,
  TFileInfoIndex,
  THashMethod,
  TMappingOptions,
  TMapResults,
  TOutputTarget,
  TProgressMessage,
} from './types'
import { OUTPUT_FILE_PREFIX } from './types'
import { createWorker } from './worker'

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type TMappingWorkerOptions = TMappingOptions & {
  outputTarget?: TOutputTarget
  hashMethod?: THashMethod
  hashPartSize?: number
}

export type ProgressCallback = (message: TProgressMessage) => void

/** Subset of Node.js worker_threads.Worker used for the 'exit' event. */
type NodeWorkerLike = {
  on(event: string, cb: (code: number) => void): void
}

// -------------------------------------------------------------------------
// Module-level state
// -------------------------------------------------------------------------

let mappingWorkerOptions: Partial<TMappingWorkerOptions> = {} // TODO: only send to worker once
export const availableMappingWorkers: Worker[] = []
let workersActive = 0
let mapResultsList: TMapResults[] | undefined
let filesMapped = 0

// Track which file each worker is currently processing. When a worker crashes
// (via onerror, on('exit'), or the stall watchdog), this map lets us identify
// the failing file and include it in the error report.
const workerCurrentFile = new Map<Worker, TFileInfo>()

// Track the last time a mapping worker, and separately the scanner, reported
// progress. Used by the stall watchdog. Kept apart because the scanner's file
// counter runs even while it is paused for backpressure (see ScanController
// in scanCore.ts), so scan activity must never be treated as evidence that
// the mapping pump itself is still alive.
let lastMappingProgressTime = 0
let lastScanProgressTime = 0

// Workers that reported 'initError'. Tracked because the failure can land
// while initializeMappingWorkers is still assembling the pool, and those
// workers must not be pushed as dispatchable afterwards.
const initFailedWorkers = new Set<Worker>()
let lastInitErrorMessage = ''

// False while initializeMappingWorkers is still assembling the pool: an
// availableMappingWorkers of zero means nothing then, so the no-workers-left
// rejection must wait until the pool is complete.
let poolInitialized = false

// Rejects the whole run. Set by curateMany via initializeMappingWorkers; used
// when every mapping worker has failed to initialize, since then no dispatch
// can ever drain the queue and 'done' is unreachable.
let rejectRunCallback: ((reason: Error) => void) | undefined

// Files whose dispatch failed back to back. Header resolution is the usual
// cause and it runs per file, so one expired token fails every file in turn:
// unbounded, a 100k-file run turns the whole queue into error results and
// reports 'done' within seconds, which an operator cannot tell apart from a
// genuine mass failure. High enough that a handful of individually bad files
// still just error and the run continues.
const MAX_CONSECUTIVE_DISPATCH_FAILURES = 20

// ...and the streak has to have lasted this long, so that on the count alone a
// token refresh that blips for a second cannot tear a run down. Files failed
// during the window surface as plain error results, indistinguishable from a
// genuinely bad file, so the retry delay below is what bounds the loss.
const MIN_DISPATCH_FAILURE_STREAK_MS = 10_000

// How long to wait after a failed dispatch while a streak is live. A failed
// dispatch returns its worker to the pool immediately, so without this the
// loop burns the whole queue before the streak is old enough to report. At
// this delay both gates above are reached together, which bounds the damage
// at roughly MAX_CONSECUTIVE_DISPATCH_FAILURES files per streak.
const DISPATCH_FAILURE_RETRY_DELAY_MS = 500
let consecutiveDispatchFailures = 0
let dispatchFailureStreakStart = 0
let dispatchFailureReported = false

// Number of replacement workers currently being created asynchronously.
// The termination condition in dispatchMappingJobs() waits for this to reach 0
// before finishing, to avoid orphaning in-flight replacements.
let pendingReplacements = 0

// Set once the termination condition has emitted 'done'. Guards the whole
// termination block: re-entering it appends the scan findings a second time to
// a mapResultsList the consumer already holds a reference to.
let doneEmitted = false

// Set to true when curateMany is aborted via AbortSignal. Guards dispatch,
// crash recovery, and worker message handlers against acting on stale state
// after teardown.
let aborted = false

// Stored fileInfoIndex from initializeMappingWorkers, used for lookup
// responses when workers query for previousMappedFileInfo.
let currentFileInfoIndex: TFileInfoIndex | undefined

// User-supplied custom uploader, set via setCustomUploader().
let currentUploader: TCustomUploader | undefined

// AbortSignal from curateMany, forwarded to currentUploader.upload() calls.
let currentSignal: AbortSignal | undefined

// Shared state accessed by both scan worker (in index.ts) and dispatch (here).
// Exported so index.ts can push items and read the queue length.
export let filesToProcess: {
  fileInfo: TFileInfo
  scanAnomalies: string[]
  previousFileInfo?: { size?: number; mtime?: string; preMappedHash?: string }
}[] = []

let directoryScanFinished = false

export function setDirectoryScanFinished(value: boolean): void {
  directoryScanFinished = value
}

// Track scan anomalies separately since they don't go through the processing pipeline
export let scanAnomalies: {
  fileInfo: TFileInfo
  anomalies: string[]
  errors?: string[]
}[] = []

// Callbacks set by curateMany, stored here for use by the dispatch loop.
let progressCallback: ProgressCallback = () => {}

// Callback to resume the scan worker when the processing queue drains below
// the low-water mark. Set by curateMany via setScanResumeCallback().
let scanResumeCallback: (() => void) | null = null
let scanPaused = false

// Total files discovered by the scanner (including those still buffered in the
// worker). Set via 'count' messages from the scan worker. When available, used
// in place of the queue-based heuristic for progress reporting.
let totalDiscoveredFiles: number | undefined

/**
 * Low-water mark for the file processing queue. When the queue size drops
 * below this threshold after a dispatch, the scan worker is resumed.
 */
const LOW_WATER_MARK = 50

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export function setMappingWorkerOptions(opts: TMappingWorkerOptions): void {
  mappingWorkerOptions = opts
}

export function setCustomUploader(uploader: TCustomUploader | undefined): void {
  currentUploader = uploader
}

export function setAbortSignal(signal: AbortSignal | undefined): void {
  currentSignal = signal
}

/**
 * Register a callback that resumes the scan worker. Called by curateMany
 * after the scan worker is created.
 */
export function setScanResumeCallback(cb: (() => void) | null): void {
  scanResumeCallback = cb
  scanPaused = false
}

/**
 * Update the total discovered file count from the scan worker's 'count'
 * messages. Pass undefined to reset (e.g. at the start of a new run).
 */
export function setTotalDiscoveredFiles(n: number | undefined): void {
  totalDiscoveredFiles = n
}

/**
 * Mark the scan as paused. Called from the scan worker message handler in
 * index.ts when the queue exceeds the high-water mark.
 */
export function markScanPaused(): void {
  scanPaused = true
}

/**
 * Hard-terminate all workers (idle and active) and reset pool state.
 * Called when curateMany is aborted via AbortSignal. Equivalent to a
 * tab reload — partially written files are handled by hash checks on
 * the next run.
 */
export function terminateAllWorkers(): void {
  aborted = true

  // Terminate idle workers
  while (availableMappingWorkers.length) {
    availableMappingWorkers.pop()!.terminate()
  }

  // Terminate active workers (those with an in-flight file)
  for (const [worker] of workerCurrentFile) {
    try {
      worker.terminate()
    } catch {
      /* already terminated */
    }
  }
  workerCurrentFile.clear()

  // Clear the queue and reset counters
  filesToProcess.length = 0
  workersActive = 0
  pendingReplacements = 0
  consecutiveDispatchFailures = 0
  doneEmitted = false
  directoryScanFinished = false
  scanPaused = false
  scanResumeCallback = null
}

/**
 * Whether the current run has been aborted. Used by worker message handlers
 * to bail out on messages arriving after teardown.
 */
export function isAborted(): boolean {
  return aborted
}

/**
 * Initialize the mapping worker pool. Call once per curateMany invocation.
 */
export async function initializeMappingWorkers(
  skipCollectingMappings?: boolean,
  fileInfoIndex?: TFileInfoIndex,
  progressCb?: ProgressCallback,
  workerCount?: number,
  rejectCb?: (reason: Error) => void,
): Promise<void> {
  // A count below one builds an empty pool, which can neither dispatch nor
  // reach the termination condition while files are queued. Rejected rather
  // than clamped: silently running with one worker would hide the caller bug.
  if (
    workerCount !== undefined &&
    (!Number.isInteger(workerCount) || workerCount < 1)
  ) {
    throw new Error(
      `workerCount must be a positive integer, received ${workerCount}`,
    )
  }

  mappingWorkerOptions = {}
  workersActive = 0
  poolInitialized = false
  initFailedWorkers.clear()
  lastInitErrorMessage = ''
  consecutiveDispatchFailures = 0
  dispatchFailureStreakStart = 0
  dispatchFailureReported = false
  rejectRunCallback = rejectCb
  mapResultsList = skipCollectingMappings ? undefined : []
  filesMapped = 0
  pendingReplacements = 0
  doneEmitted = false
  aborted = false
  workerCurrentFile.clear()
  lastMappingProgressTime = Date.now()
  lastScanProgressTime = Date.now()
  currentFileInfoIndex = fileInfoIndex
  currentUploader = undefined
  filesToProcess = []
  directoryScanFinished = false
  scanAnomalies = []
  totalDiscoveredFiles = undefined

  if (progressCb) progressCallback = progressCb

  const effectiveWorkerCount =
    workerCount ?? Math.min(await getHardwareConcurrency(), 8)
  const workers = await Promise.all(
    Array.from({ length: effectiveWorkerCount }, () => createMappingWorker()),
  )
  // A worker whose 'initError' already arrived was terminated by
  // handleWorkerInitFailure before this push and must not become dispatchable.
  availableMappingWorkers.push(
    ...workers.filter((worker) => !initFailedWorkers.has(worker)),
  )
  poolInitialized = true
  rejectIfNoWorkersLeft(
    `All mapping workers failed to initialize: ${lastInitErrorMessage}`,
  )
}

/**
 * Dispatch queued files to available mapping workers.
 * Also checks the termination condition (all files processed, no pending
 * replacements, scan finished) and emits the 'done' progress message.
 */
export async function dispatchMappingJobs(): Promise<void> {
  if (aborted) return

  while (filesToProcess.length > 0 && availableMappingWorkers.length > 0) {
    const { fileInfo, previousFileInfo } = filesToProcess.pop()!
    const mappingWorker = availableMappingWorkers.pop()!

    // Track which file this worker is processing so we can identify it
    // if the worker crashes.
    workerCurrentFile.set(mappingWorker, fileInfo)

    // Increment before the awaits below: a concurrent dispatchMappingJobs() call
    // triggered by a finishing worker must see a non-zero count or it will emit
    // 'done' prematurely while headers are still being resolved.
    workersActive += 1

    const { outputTarget, hashMethod, hashPartSize, ...mappingOptions } =
      // Not partial anymore.
      mappingWorkerOptions as TMappingWorkerOptions

    // A header provider that rejects (expired credentials, a network failure)
    // would otherwise leave this file popped and this worker slot consumed for
    // the rest of the run, so the termination condition could never be met.
    try {
      mappingWorker.postMessage({
        request: 'apply',
        fileInfo: await getHttpInputHeaders(fileInfo),
        outputTarget: await getHttpOutputHeaders(outputTarget),
        previousFileInfo,
        hashMethod,
        hashPartSize,
        serializedMappingOptions: serializeMappingOptions(mappingOptions),
      } satisfies MappingRequest)
      consecutiveDispatchFailures = 0
      dispatchFailureReported = false
    } catch (error) {
      // Same double-recovery guard as recoverCrashedWorker, and for the same
      // reason: this await can outlive its file. The stall watchdog may have
      // already recovered the worker, or an abort may have cleared the map --
      // accounting again would double-count the file, return a terminated
      // worker to the pool, and drive workersActive to -1. Continue rather
      // than return: the queue drain, the backpressure resume and the
      // termination check below still belong to this pass.
      if (!workerCurrentFile.has(mappingWorker)) continue

      console.error(
        'Failed to dispatch file to mapping worker:',
        error,
        `File: ${fileInfo.path}/${fileInfo.name}`,
      )
      const message = error instanceof Error ? error.message : String(error)
      failFileAndReturnWorker(mappingWorker, fileInfo, message)

      // Reported once per streak (a success resets it). The run owner decides
      // what to do: its rejection tears the pool down, which empties the queue
      // and ends this loop. With no callback wired the run drains into error
      // results as before.
      if (consecutiveDispatchFailures === 0) {
        dispatchFailureStreakStart = Date.now()
      }
      consecutiveDispatchFailures += 1
      const streakDuration = Date.now() - dispatchFailureStreakStart
      if (
        !dispatchFailureReported &&
        consecutiveDispatchFailures >= MAX_CONSECUTIVE_DISPATCH_FAILURES &&
        streakDuration >= MIN_DISPATCH_FAILURE_STREAK_MS
      ) {
        dispatchFailureReported = true
        rejectRunCallback?.(
          new Error(
            `Dispatch failed for ${consecutiveDispatchFailures} consecutive files over ${Math.round(streakDuration / 1000)}s, last: ${message}`,
          ),
        )
      }

      // Reporting tears the pool down, which clears the queue and ends this
      // loop, so only an unreported streak is worth slowing down.
      if (!dispatchFailureReported) {
        await new Promise((resolve) =>
          setTimeout(resolve, DISPATCH_FAILURE_RETRY_DELAY_MS),
        )
        // The run can be torn down during that wait.
        if (aborted) return
      }
    }
  }

  // Backpressure: resume the scan worker when the queue drains below the
  // low-water mark. This prevents the queue from staying empty while the
  // scan worker is paused.
  if (
    scanPaused &&
    filesToProcess.length < LOW_WATER_MARK &&
    scanResumeCallback
  ) {
    scanPaused = false
    scanResumeCallback()
  }

  if (
    !doneEmitted &&
    workersActive === 0 &&
    pendingReplacements === 0 &&
    directoryScanFinished &&
    filesToProcess.length === 0
  ) {
    doneEmitted = true

    // End and remove all workers
    while (availableMappingWorkers.length) {
      availableMappingWorkers.pop()!.terminate()
    }

    console.log(`Finished mapping ${filesMapped} files`)
    console.log('job is finished')

    if (!mapResultsList) mapResultsList = []

    // Create individual mapResults entries for each scan finding.
    //
    // Two kinds of scan findings are surfaced differently:
    //
    //  - Benign anomalies (non-DICOM, too-small, excluded filetypes): noise
    //    during the first pass (form generation), so only emitted on the
    //    write pass (!skipWrite), and they carry the input path in
    //    `outputFilePath` as before.
    //
    //  - Hard read errors (file could not be read at all): always surfaced,
    //    in both passes, via `errors`. We deliberately OMIT `outputFilePath`
    //    so the raw input path is not leaked into the server-bound log; the
    //    raw path is retained in `fileInfo` for the private (input) log, and a
    //    path-less trace is rendered in the server-bound log by the consumer.
    scanAnomalies.forEach(({ fileInfo, anomalies, errors }) => {
      const hasReadErrors = !!errors && errors.length > 0

      if (hasReadErrors) {
        const scanErrorResult: TMapResults = {
          // phiSafeToken rather than the sanitised name: this result reaches
          // the server-bound log, so the UID must not encode the filename.
          sourceInstanceUID: `scan_${phiSafeToken(`${fileInfo.path}/${fileInfo.name}`)}`,
          // Intentionally no outputFilePath: an unread file has no
          // de-identified output path, and we must not place the raw input
          // path in the server-bound channel.
          mappings: {},
          anomalies: anomalies ?? [],
          errors,
          quarantine: {},
          fileInfo,
        }
        mapResultsList!.push(scanErrorResult)
        return
      }

      // Benign anomalies: only on the write pass.
      if (!mappingWorkerOptions.skipWrite && anomalies.length > 0) {
        const scanAnomalyResult: TMapResults = {
          sourceInstanceUID: `scan_${fileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
          outputFilePath: `${fileInfo.path}/${fileInfo.name}`, // Use the actual file path
          mappings: {},
          anomalies: anomalies, // Keep the original anomalies array
          errors: [],
          quarantine: {},
        }
        mapResultsList!.push(scanAnomalyResult)
      }
    })

    safeProgress({
      response: 'done',
      mapResultsList: mapResultsList,
      processedFiles: filesMapped,
      totalFiles: filesMapped,
      // Always true here -- the termination condition requires it -- but set
      // explicitly so a consumer never reads `undefined` on the final message.
      scanComplete: true,
    })
  }
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

/**
 * Report progress without letting a consumer throw escape into the pool.
 *
 * Reporting sits between `workersActive -= 1` and `dispatchMappingJobs()`,
 * which is the only place backpressure is released and 'done' is emitted, so an
 * escaping throw wedges the run -- or, from the 'done' site, becomes an
 * unhandled rejection, since dispatch is always called unawaited.
 */
function safeProgress(message: TProgressMessage): void {
  try {
    progressCallback(message)
  } catch (error) {
    console.error('Progress callback threw; continuing:', error)
  }
}

/**
 * Account for a file that could not be mapped and return its worker to the
 * pool, reporting it in the same shape as a worker-reported error.
 *
 * Shared by every non-crash failure path, so the pool's invariant holds in one
 * place: each popped file ends up mapped or errored exactly once, and each
 * popped worker goes back to the pool.
 */
function failFileAndReturnWorker(
  mappingWorker: Worker,
  fileInfo: TFileInfo | undefined,
  errorMessage: string,
): void {
  const errorMapResults: TMapResults = {
    sourceInstanceUID: `error_${filesMapped + 1}`,
    outputFilePath: '',
    mappings: {},
    anomalies: [],
    errors: [errorMessage],
    quarantine: {},
    fileInfo,
  }

  availableMappingWorkers.push(mappingWorker)
  workerCurrentFile.delete(mappingWorker)
  mapResultsList?.push(errorMapResults)
  workersActive -= 1
  filesMapped += 1

  safeProgress({
    response: 'progress',
    mapResults: errorMapResults,
    processedFiles: filesMapped,
    totalFiles:
      totalDiscoveredFiles ??
      filesToProcess.length + filesMapped + workersActive,
    scanComplete: directoryScanFinished,
  })
}

/**
 * Return the number of logical CPUs available, working in both browser and
 * Node.js environments. Falls back to `os.cpus().length` when the global
 * `navigator` object is not available (Node.js < 21).
 */
async function getHardwareConcurrency(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency
  }
  const { cpus } = await import('node:os')
  return cpus().length
}

/**
 * Recover from a mapping worker crash. Returns the worker slot, counts the
 * in-flight file as a mapping error, and re-dispatches. Called from onerror,
 * on('exit'), and the stall watchdog.
 */
function recoverCrashedWorker(
  mappingWorker: Worker,
  errorMessage: string,
): void {
  // Bail out if processing has been aborted — no recovery needed.
  if (aborted) return

  // Guard against double-recovery (e.g., both onerror and on('exit') firing
  // for the same crash). Without this, workersActive could go negative.
  if (!workerCurrentFile.has(mappingWorker)) {
    return
  }

  const fileInfo = workerCurrentFile.get(mappingWorker)
  workerCurrentFile.delete(mappingWorker)

  console.error(
    `Mapping worker crashed: ${errorMessage}`,
    fileInfo ? `File: ${fileInfo.path}/${fileInfo.name}` : '(unknown file)',
  )

  // Terminate the crashed worker and create error results
  try {
    mappingWorker.terminate()
  } catch {
    // Worker may already be terminated
  }

  const errorMapResults: TMapResults = {
    sourceInstanceUID: `worker_crash_${filesMapped + 1}`,
    outputFilePath: '',
    mappings: {},
    anomalies: [],
    errors: [errorMessage],
    quarantine: {},
    fileInfo,
  }

  mapResultsList?.push(errorMapResults)
  workersActive -= 1
  filesMapped += 1

  safeProgress({
    response: 'progress',
    mapResults: errorMapResults,
    processedFiles: filesMapped,
    totalFiles:
      totalDiscoveredFiles ??
      filesToProcess.length + filesMapped + workersActive,
    scanComplete: directoryScanFinished,
  })

  // Counted before dispatching: with an empty queue dispatchMappingJobs() runs
  // straight through to the termination check, so incrementing afterwards lets
  // 'done' fire while this replacement is in flight -- orphaning the worker it
  // creates and re-entering the termination block once it joins the pool.
  spawnReplacementWorker()

  dispatchMappingJobs()
}

/**
 * Drop an idle worker that broke the message protocol and replace it. It holds
 * no file, so there is nothing to account -- but leaving it in the pool means
 * handing it the next one.
 */
function retireIdleWorker(mappingWorker: Worker): void {
  if (aborted) return

  const index = availableMappingWorkers.indexOf(mappingWorker)
  if (index !== -1) availableMappingWorkers.splice(index, 1)
  try {
    mappingWorker.terminate()
  } catch {
    // Worker may already be terminated
  }

  // Before the dispatch, for the reason spelled out in recoverCrashedWorker.
  spawnReplacementWorker()

  dispatchMappingJobs()
}

/**
 * Spawn a replacement for a worker that has left the pool, so the pool doesn't
 * shrink permanently -- a directory with many problematic files could otherwise
 * kill every worker.
 *
 * Increments pendingReplacements synchronously, so callers must call this
 * before any dispatch that could otherwise reach the termination check.
 */
function spawnReplacementWorker(): void {
  pendingReplacements += 1

  void createMappingWorker()
    .then((worker) => {
      pendingReplacements -= 1
      // If processing was aborted while the replacement was being created,
      // terminate it immediately instead of adding it to the pool.
      if (aborted) {
        worker.terminate()
        return
      }
      availableMappingWorkers.push(worker)
      dispatchMappingJobs()
    })
    .catch((error: unknown) => {
      console.error('Failed to create replacement worker:', error)
      pendingReplacements -= 1
      dispatchMappingJobs()
      // Whatever killed the worker can equally stop a new one being built (an
      // OOM kill takes the thread and the memory to replace it), and this may
      // have been the last worker. Nothing else notices: the queue keeps its
      // files and no dispatch can ever run again.
      rejectIfNoWorkersLeft(
        `No mapping workers left: a replacement could not be created (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    })
}

/**
 * Reject the run once no mapping worker is left to do any work. Dispatch needs
 * an available worker and the termination condition needs an empty queue, so
 * an empty pool with files still queued can satisfy neither: nothing would
 * ever settle the run again.
 *
 * Not meaningful while initializeMappingWorkers is still assembling the pool
 * (an empty pool then is just one not built yet), nor once the run is over.
 */
function rejectIfNoWorkersLeft(reason: string): void {
  if (!poolInitialized || aborted || doneEmitted) return
  if (
    availableMappingWorkers.length > 0 ||
    workersActive > 0 ||
    pendingReplacements > 0
  ) {
    return
  }
  rejectRunCallback?.(new Error(reason))
}

/**
 * Handle a worker that reported 'initError': its environment never
 * initialized, so it can never answer a dispatch. Distinct from a crash
 * because the common case is an idle worker -- the pool has no ready
 * handshake, so workers become dispatchable before their module has loaded.
 */
function handleWorkerInitFailure(mappingWorker: Worker, error: string): void {
  if (aborted) return

  console.error('Mapping worker failed to initialize:', error)
  lastInitErrorMessage = error
  initFailedWorkers.add(mappingWorker)

  // A file was dispatched before the failure surfaced: recover it like any
  // crash. A pool-wide breakage makes the replacement fail the same way, but
  // fast, so this converges on the idle path below rather than stalling.
  if (workerCurrentFile.has(mappingWorker)) {
    recoverCrashedWorker(
      mappingWorker,
      `Mapping worker failed to initialize: ${error}`,
    )
    return
  }

  // Idle worker: remove it so it can never receive a file, and spawn no
  // replacement -- an environment that cannot initialize a worker will not
  // do better on retry.
  const index = availableMappingWorkers.indexOf(mappingWorker)
  if (index !== -1) availableMappingWorkers.splice(index, 1)
  try {
    mappingWorker.terminate()
  } catch {
    // Worker may already be terminated
  }

  rejectIfNoWorkersLeft(
    `All mapping workers failed to initialize: ${lastInitErrorMessage}`,
  )
}

/**
 * Create a single mapping worker with all error/exit/message handlers attached.
 * Used by both initializeMappingWorkers (initial pool) and recoverCrashedWorker
 * (replacement after crash).
 */
async function createMappingWorker(): Promise<Worker> {
  const mappingWorker = await createWorker(
    new URL('./applyMappingsWorker.js', import.meta.url),
    { type: 'module' },
  )

  // Handle worker-level errors (uncaught exceptions, DataCloneError, etc.).
  // The previous `onerror = console.error` only logged and did not recover
  // the worker slot, causing curateMany to hang.
  mappingWorker.onerror = (event) => {
    const errorMessage =
      'message' in event
        ? (event as { message: string }).message
        : `Worker error: ${String(event)}`
    recoverCrashedWorker(mappingWorker, errorMessage)
  }

  // Handle unexpected worker exit (OOM, segfault, unhandled rejection that
  // kills the thread). Only available in Node.js worker_threads.
  if ('on' in mappingWorker) {
    ;(mappingWorker as unknown as NodeWorkerLike).on('exit', (code: number) => {
      // Normal exit (code 0) after terminate() is expected -- ignore it.
      // Non-zero exit means the worker crashed.
      if (code !== 0 && workerCurrentFile.has(mappingWorker)) {
        recoverCrashedWorker(
          mappingWorker,
          `Worker exited unexpectedly with code ${code}`,
        )
      }
    })
  }

  mappingWorker.addEventListener('message', (event) => {
    // Ignore messages from workers after abort — the pool is torn down.
    if (aborted) return

    // Any message from a worker means mapping progress is being made.
    // Recorded before the lookup/upload branches below so a consumer upload
    // that generates message traffic isn't mistaken for a hung worker -- a
    // single upload that stays completely silent for the full 10 minutes
    // still trips the watchdog, since there's no per-upload progress signal
    // to hook here.
    lastMappingProgressTime = Date.now()

    // Handle lookup requests from the worker. The worker sends these when
    // curateOne needs to check if a mapped file was already uploaded
    // (previousMappedFileInfo). The index is kept on the main thread to
    // avoid copying 200k+ entries to every worker.
    if (event.data.response === 'lookup') {
      const outputPath: string = event.data.outputPath
      const entry = currentFileInfoIndex?.[OUTPUT_FILE_PREFIX + outputPath]
      mappingWorker.postMessage({
        response: 'lookupResult',
        postMappedHash: entry?.postMappedHash,
      })
      return
    }

    if (event.data.response === 'upload') {
      const msg = event.data as {
        response: 'upload'
        key: string
        stream: ReadableStream<Uint8Array>
        size: number
        contentType?: string
        headers?: Record<string, string>
      }
      if (!currentUploader) {
        mappingWorker.postMessage({
          response: 'uploadError',
          error: 'No custom uploader configured',
        } satisfies UploadError)
        return
      }
      currentUploader
        .upload({
          key: msg.key,
          stream: msg.stream,
          size: msg.size,
          contentType: msg.contentType,
          headers: msg.headers,
          signal: currentSignal,
        })
        .then((result) => {
          mappingWorker.postMessage({
            response: 'uploadResult',
            etag: result.etag,
          } satisfies UploadResult)
        })
        .catch((e: unknown) => {
          mappingWorker.postMessage({
            response: 'uploadError',
            error: safeSerializeError(e),
          } satisfies UploadError)
        })
      return
    }

    switch (event.data.response) {
      case 'finished':
        // A reply that arrives after this worker was already recovered (stall
        // watchdog, or the default: branch below) would count its file twice,
        // push a terminated worker back into the pool, and drive workersActive
        // to -1 -- past which the termination condition can never hold.
        if (!workerCurrentFile.has(mappingWorker)) break
        workerCurrentFile.delete(mappingWorker)
        availableMappingWorkers.push(mappingWorker)

        // Insert null if skipping mapping collection
        mapResultsList?.push(event.data.mapResults)
        filesMapped += 1
        workersActive -= 1

        // Report progress
        safeProgress({
          response: 'progress',
          mapResults: event.data.mapResults,
          processedFiles: filesMapped,
          totalFiles:
            totalDiscoveredFiles ??
            filesToProcess.length + filesMapped + workersActive,
          scanComplete: directoryScanFinished,
        })

        dispatchMappingJobs()
        if (filesMapped % 100 === 0) {
          console.log(`Finished mapping ${filesMapped} files`)
        }
        break
      case 'error': {
        console.error('Error in mapping worker:', event.data.error)
        // Same guard as 'finished': the file may already have been accounted
        // by a recovery that ran while this reply was in flight.
        if (!workerCurrentFile.has(mappingWorker)) break
        failFileAndReturnWorker(
          mappingWorker,
          event.data.fileInfo,
          event.data.error.toString(),
        )
        dispatchMappingJobs()

        break
      }
      case 'initError':
        handleWorkerInitFailure(mappingWorker, event.data.error)
        break
      default:
        // An unrecognised message says nothing about whether the worker is
        // still busy, so returning it to the pool risks double-counting its
        // file when it does reply. A busy worker is recovered like a crash,
        // which accounts its file exactly once; an idle one has no file to
        // account but must still go, since recoverCrashedWorker would ignore
        // it and leave it in the pool to be handed the next file.
        console.error(`Unknown response from worker ${event.data.response}`)
        if (workerCurrentFile.has(mappingWorker)) {
          recoverCrashedWorker(
            mappingWorker,
            `Unknown response from worker: ${String(event.data.response)}`,
          )
        } else {
          retireIdleWorker(mappingWorker)
        }
        break
    }
  })

  return mappingWorker
}

/**
 * Get the workerCurrentFile map. Used by the stall watchdog in curateMany
 * to iterate over stuck workers.
 */
export function getWorkerCurrentFile(): Map<Worker, TFileInfo> {
  return workerCurrentFile
}

/**
 * Get the current count of active workers. Used by the stall watchdog.
 */
export function getWorkersActive(): number {
  return workersActive
}

/**
 * Get the last time a mapping worker reported progress. Used by the stall
 * watchdog while mapping work is outstanding.
 */
export function getLastMappingProgressTime(): number {
  return lastMappingProgressTime
}

/**
 * Get the last time the scanner reported progress, including its
 * backpressure-immune file counter. Used by the stall watchdog only once
 * there is no mapping work outstanding and it is waiting on the scan itself.
 */
export function getLastScanProgressTime(): number {
  return lastScanProgressTime
}

/**
 * Number of replacement workers still being created. Used by the stall
 * watchdog: the pool's termination condition waits on this, so a run with a
 * replacement in flight is not finished no matter how idle it looks.
 */
export function getPendingReplacements(): number {
  return pendingReplacements
}

/**
 * Whether the directory scan has finished. Used by the stall watchdog to tell
 * an idle-but-unfinished run from a completed one.
 */
export function isDirectoryScanFinished(): boolean {
  return directoryScanFinished
}

/**
 * Refresh the scan progress baseline. Called on every scan-worker message,
 * including the backpressure-immune file counter -- so this must only ever
 * stand as evidence the scanner is alive, never the mapping pump.
 */
export function resetScanProgressTime(): void {
  lastScanProgressTime = Date.now()
}

/**
 * Restart both stall watchdog baselines after it has taken recovery action,
 * so a run that stays stuck reports once per timeout rather than once per
 * watchdog tick.
 */
export function resetProgressTimestamps(): void {
  lastMappingProgressTime = Date.now()
  lastScanProgressTime = Date.now()
}
