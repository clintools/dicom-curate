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

// Track the last time any worker reported progress, used by the stall watchdog.
let lastWorkerProgressTime = 0

// Number of replacement workers currently being created asynchronously.
// The termination condition in dispatchMappingJobs() waits for this to reach 0
// before finishing, to avoid orphaning in-flight replacements.
let pendingReplacements = 0

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
// Exported so index.ts can push items and set the scan-finished flag.
export let filesToProcess: {
  fileInfo: TFileInfo
  scanAnomalies: string[]
  previousFileInfo?: { size?: number; mtime?: string; preMappedHash?: string }
}[] = []

export let directoryScanFinished = false

export function setDirectoryScanFinished(value: boolean): void {
  directoryScanFinished = value
}

// Track scan anomalies separately since they don't go through the processing pipeline
export let scanAnomalies: { fileInfo: TFileInfo; anomalies: string[] }[] = []

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
): Promise<void> {
  mappingWorkerOptions = {}
  workersActive = 0
  mapResultsList = skipCollectingMappings ? undefined : []
  filesMapped = 0
  pendingReplacements = 0
  aborted = false
  workerCurrentFile.clear()
  lastWorkerProgressTime = Date.now()
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
  availableMappingWorkers.push(...workers)
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
    mappingWorker.postMessage({
      request: 'apply',
      fileInfo: await getHttpInputHeaders(fileInfo),
      outputTarget: await getHttpOutputHeaders(outputTarget),
      previousFileInfo,
      hashMethod,
      hashPartSize,
      serializedMappingOptions: serializeMappingOptions(mappingOptions),
    } satisfies MappingRequest)
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
    workersActive === 0 &&
    pendingReplacements === 0 &&
    directoryScanFinished &&
    filesToProcess.length === 0
  ) {
    // End and remove all workers
    while (availableMappingWorkers.length) {
      availableMappingWorkers.pop()!.terminate()
    }

    console.log(`Finished mapping ${filesMapped} files`)
    console.log('job is finished')

    if (!mapResultsList) mapResultsList = []

    // Create individual mapResults entries for each scan anomaly
    // Only do this during actual processing (not first pass)
    if (!mappingWorkerOptions.skipWrite) {
      scanAnomalies.forEach(({ fileInfo, anomalies }) => {
        const scanAnomalyResult: TMapResults = {
          sourceInstanceUID: `scan_${fileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
          outputFilePath: `${fileInfo.path}/${fileInfo.name}`, // Use the actual file path
          mappings: {},
          anomalies: anomalies, // Keep the original anomalies array
          errors: [],
          quarantine: {},
        }

        // Add each scan anomaly result to the final results
        mapResultsList!.push(scanAnomalyResult)
      })
    }

    progressCallback({
      response: 'done',
      mapResultsList: mapResultsList,
      processedFiles: filesMapped,
      totalFiles: filesMapped,
    })
  }
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

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

  progressCallback({
    response: 'progress',
    mapResults: errorMapResults,
    processedFiles: filesMapped,
    totalFiles:
      totalDiscoveredFiles ??
      filesToProcess.length + filesMapped + workersActive,
  })

  dispatchMappingJobs()

  // Spawn a replacement worker so the pool doesn't shrink permanently.
  // A directory with many problematic files could otherwise kill all workers.
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
    .catch((error) => {
      console.error('Failed to create replacement worker:', error)
      pendingReplacements -= 1
      dispatchMappingJobs()
    })
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

    // Any message from a worker means progress is being made.
    lastWorkerProgressTime = Date.now()
    workerCurrentFile.delete(mappingWorker)

    switch (event.data.response) {
      case 'finished':
        availableMappingWorkers.push(mappingWorker)

        // Insert null if skipping mapping collection
        mapResultsList?.push(event.data.mapResults)
        filesMapped += 1
        workersActive -= 1

        // Report progress
        progressCallback({
          response: 'progress',
          mapResults: event.data.mapResults,
          processedFiles: filesMapped,
          totalFiles:
            totalDiscoveredFiles ??
            filesToProcess.length + filesMapped + workersActive,
        })

        dispatchMappingJobs()
        if (filesMapped % 100 === 0) {
          console.log(`Finished mapping ${filesMapped} files`)
        }
        break
      case 'error': {
        console.error('Error in mapping worker:', event.data.error)
        availableMappingWorkers.push(mappingWorker)

        const errorMapResults: TMapResults = {
          sourceInstanceUID: `error_${filesMapped + 1}`,
          outputFilePath: '',
          mappings: {},
          anomalies: [],
          errors: [event.data.error.toString()],
          quarantine: {},
          fileInfo: event.data.fileInfo,
        }

        mapResultsList?.push(errorMapResults)
        workersActive -= 1
        filesMapped += 1

        progressCallback({
          response: 'progress',
          mapResults: errorMapResults,
          processedFiles: filesMapped,
          totalFiles:
            totalDiscoveredFiles ??
            filesToProcess.length + filesMapped + workersActive,
        })
        dispatchMappingJobs()

        break
      }
      default:
        console.error(`Unknown response from worker ${event.data.response}`)
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
 * Get the last time a worker reported progress. Used by the stall watchdog.
 */
export function getLastWorkerProgressTime(): number {
  return lastWorkerProgressTime
}
