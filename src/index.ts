import { extractColumnMappings, TColumnMappings } from './csvMapping'
import { curateOne } from './curateOne'
import { composeSpecs } from './composeSpecs'
import { iso8601 } from './offsetDateTime'
import picomatch from 'picomatch'

import type {
  TFileInfo,
  OrganizeOptions,
  TProgressMessageDone,
  TPs315Options,
  TCurationSpecification,
} from './types'

import type { FileScanMsg, FileScanRequest } from './scanDirectoryWorker'
import { createWorker } from './worker'

import {
  type TMappingWorkerOptions,
  type ProgressCallback,
  availableMappingWorkers,
  filesToProcess,
  scanAnomalies,
  setDirectoryScanFinished,
  setMappingWorkerOptions,
  initializeMappingWorkers,
  dispatchMappingJobs,
  getWorkerCurrentFile,
  getWorkersActive,
  getLastWorkerProgressTime,
  setScanResumeCallback,
  markScanPaused,
  terminateAllWorkers,
} from './mappingWorkerPool'

export type { ProgressCallback } from './mappingWorkerPool'

export type {
  TPs315Options,
  TMapResults,
  TProgressMessage,
  OrganizeOptions,
  TCurationSpecification,
} from './types'

export { TCurateOneArgs } from './curateOne'

export { specVersion } from './config/specVersion'
export { csvTextToRows } from './csvMapping'
export type { Row } from './csvMapping'
export { composeSpecs } from './composeSpecs'
export type { SpecPart } from './composeSpecs'
export { hash } from './hash'

function requiresDateOffset(
  deIdOpts: TPs315Options | 'Off',
): deIdOpts is TPs315Options & {
  retainLongitudinalTemporalInformationOptions: 'Offset'
} {
  return (
    deIdOpts !== 'Off' &&
    deIdOpts.retainLongitudinalTemporalInformationOptions === 'Offset'
  )
}

/*
 * Directory scanner web worker management
 *
 * worker accepts these messages:
 *   command: 'scan', directoryHandle
 *   command: 'stop'
 * worker sends these messages:
 *   response: 'file', file info (TFileInfo)
 *   response: 'done'
 */
// TODO: implement a buffering stream to request fileHandles in batches
async function initializeFileListWorker(
  rejectCallback: (reason: Error) => void,
) {
  const fileListWorker = await createWorker(
    new URL('./scanDirectoryWorker.js', import.meta.url),
    { type: 'module' },
  )

  fileListWorker.onerror = (error) => {
    console.error('Scan worker crashed:', error)
    // Terminate all mapping workers (both idle and active)
    while (availableMappingWorkers.length) {
      availableMappingWorkers.pop()!.terminate()
    }
    rejectCallback(
      new Error(
        `Scan worker crashed: ${'message' in error ? (error as { message: string }).message : String(error)}`,
      ),
    )
  }

  fileListWorker.addEventListener(
    'message',
    (event: MessageEvent<FileScanMsg>) => {
      switch (event.data.response) {
        case 'file': {
          const { fileInfo, previousFileInfo } = event.data
          filesToProcess.push({
            fileInfo,
            scanAnomalies: [], // Files sent to processing have no scan anomalies
            previousFileInfo,
          })

          // Backpressure: when the queue grows too large, pause the scan
          // worker so file handles don't accumulate unboundedly in memory.
          // The scan worker supports 'stop' and 'resume' commands.
          const HIGH_WATER_MARK = 100
          if (filesToProcess.length > HIGH_WATER_MARK) {
            fileListWorker.postMessage({ request: 'stop' })
            markScanPaused()
          }
          dispatchMappingJobs()
          break
        }
        case 'scanAnomalies': {
          // Handle scan anomalies separately - they don't go to processing
          const { fileInfo: anomalyFileInfo, anomalies } = event.data
          scanAnomalies.push({ fileInfo: anomalyFileInfo, anomalies })
          break
        }
        case 'done': {
          console.log('directoryScanFinished')
          setDirectoryScanFinished(true)
          break
        }
        case 'error': {
          console.error('Scan worker error:', event.data.error)
          fileListWorker.terminate()
          // Terminate all mapping workers (both idle and active)
          while (availableMappingWorkers.length) {
            availableMappingWorkers.pop()!.terminate()
          }
          rejectCallback(new Error(event.data.error))
          break
        }
        default: {
          // @ts-expect-error: response is string here, not never
          console.error(`Unknown response from worker ${event.data.response}`)
        }
      }
      dispatchMappingJobs()
    },
  )

  return fileListWorker
}

async function collectMappingOptions(
  organizeOptions: OrganizeOptions,
): Promise<TMappingWorkerOptions> {
  //
  // first, get the folder mappings and set output directory
  //

  let outputTarget: TMappingWorkerOptions['outputTarget'] = {}
  if (organizeOptions.outputEndpoint) {
    if ('bucketName' in organizeOptions.outputEndpoint) {
      outputTarget.s3 = organizeOptions.outputEndpoint
    } else {
      outputTarget.http = organizeOptions.outputEndpoint
    }
  } else if (organizeOptions.outputDirectory) {
    outputTarget.directory = organizeOptions.outputDirectory
  }

  //
  // then, get the curation spec
  //
  const curationSpec = organizeOptions.curationSpec

  let additionalData: TCurationSpecification['additionalData'] | undefined
  let deIdOpts: TPs315Options | 'Off' = 'Off'

  if (typeof curationSpec === 'function') {
    ;({ dicomPS315EOptions: deIdOpts, additionalData } =
      composeSpecs(curationSpec()))
  }

  // Parse the column mappings if the spec requires them and they exist.
  // The need for mapping can come from additionalData or from the
  // retainLongitudinalTemporalInformationOptions option
  let columnMappings: TColumnMappings | undefined
  if (organizeOptions.table && additionalData) {
    columnMappings = extractColumnMappings(
      organizeOptions.table,
      additionalData.mapping,
    )
  }

  const skipWrite = organizeOptions.skipWrite ?? false
  const skipModifications = organizeOptions.skipModifications ?? false
  const skipValidation = organizeOptions.skipValidation ?? false
  const hashMethod = organizeOptions.hashMethod
  const hashPartSize = organizeOptions.hashPartSize

  const dateOffset = organizeOptions.dateOffset

  if (requiresDateOffset(deIdOpts) && !dateOffset?.match(iso8601)) {
    throw new Error(
      'When using "Offset" for retainLongitudinalTemporalInformationOptions, an iso8601 compatible dateOffset must be provided.',
    )
  }

  return {
    outputTarget,
    columnMappings,
    curationSpec,
    skipWrite,
    skipModifications,
    skipValidation,
    dateOffset,
    hashMethod,
    hashPartSize,
  }
}

function queueFilesForMapping(
  organizeOptions: Extract<OrganizeOptions, { inputType: 'files' }>,
) {
  organizeOptions.inputFiles.forEach((inputFile) => {
    const fileInfo: TFileInfo = {
      path: '',
      name: inputFile.name,
      size: inputFile.size,
      kind: 'blob',
      blob: inputFile,
    }
    filesToProcess.push({
      fileInfo,
      scanAnomalies: [],
    })
  })
  // Dispatch jobs once after all files are queued to prevent race conditions
  dispatchMappingJobs()
}

function queueUrlsForMapping(
  organizeOptions: Extract<OrganizeOptions, { inputType: 'http' }>,
) {
  organizeOptions.inputUrls.forEach((inputUrl) => {
    const fileInfo: TFileInfo = {
      kind: 'http',
      url: inputUrl,
      headers: organizeOptions.headers,
      size: -1,
      name: inputUrl,
      path: inputUrl,
    }
    filesToProcess.push({
      fileInfo,
      scanAnomalies: [],
    })
  })

  dispatchMappingJobs()
  setDirectoryScanFinished(true)
}

async function curateMany(
  organizeOptions: OrganizeOptions,
  onProgress?: ProgressCallback,
): Promise<TProgressMessageDone> {
  // Early rejection for pre-aborted signal — don't create any workers.
  if (organizeOptions.signal?.aborted) {
    return Promise.reject(
      new DOMException('The operation was aborted.', 'AbortError'),
    )
  }

  return new Promise<TProgressMessageDone>(async (resolve, reject) => {
    // Prevents double-settle when abort races with natural completion.
    let settled = false

    const signal = organizeOptions.signal

    // Stall watchdog: if no mapping worker at all has reported back for 10
    // minutes (i.e., all active workers are stuck), terminate them and count
    // their in-flight files as mapping errors. This guards against undetectable
    // worker crashes (e.g., OOM kills that don't trigger onerror or on('exit')).
    const STALL_TIMEOUT_MS = 10 * 60 * 1000
    const stallWatchdog = setInterval(() => {
      if (
        getWorkersActive() > 0 &&
        Date.now() - getLastWorkerProgressTime() > STALL_TIMEOUT_MS
      ) {
        console.error(
          `Stall detected: ${getWorkersActive()} mapping worker(s) have not responded for 10 minutes.`,
        )
        const workerCurrentFile = getWorkerCurrentFile()
        // Recover all stuck workers. Iterate over a copy since
        // recoverCrashedWorker modifies workerCurrentFile.
        for (const [worker] of [...workerCurrentFile]) {
          // Import recoverCrashedWorker indirectly via the worker's onerror.
          // The onerror handler calls recoverCrashedWorker internally.
          if (worker.onerror) {
            // Synthetic error event -- avoid ErrorEvent constructor which is
            // unavailable in Node.js < 23. The onerror handler only reads
            // event.message via duck-typing so a plain object suffices.
            worker.onerror({
              message: 'Worker stalled (no response for 10 minutes)',
            } as unknown as ErrorEvent)
          }
        }
      }
    }, 60_000)

    // Progress callback wraps the user's callback and handles lifecycle
    const progressCallback: ProgressCallback = (msg) => {
      onProgress?.(msg)

      if (msg.response === 'done' && !settled) {
        settled = true
        clearInterval(stallWatchdog)
        signal?.removeEventListener('abort', onAbort)
        resolve(msg)
      }
    }

    const rejectCallback = (reason: Error) => {
      if (settled) return
      settled = true
      clearInterval(stallWatchdog)
      signal?.removeEventListener('abort', onAbort)
      reject(reason)
    }

    // Reference to the scan worker, hoisted so the abort handler can
    // terminate it. Assigned later when a directory/path/s3 input is used.
    let fileListWorker: Worker | undefined

    const onAbort = () => {
      // Terminate the scan worker if it exists
      try {
        fileListWorker?.terminate()
      } catch {
        /* already terminated */
      }

      // Hard-terminate all mapping workers and reset pool state
      terminateAllWorkers()

      // Reject with standard AbortError
      rejectCallback(
        new DOMException('The operation was aborted.', 'AbortError'),
      )
    }

    if (signal) {
      // Re-check in case abort happened between the early check and here
      if (signal.aborted) {
        clearInterval(stallWatchdog)
        rejectCallback(
          new DOMException('The operation was aborted.', 'AbortError'),
        )
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      // create the mapping workers
      await initializeMappingWorkers(
        organizeOptions.skipCollectingMappings,
        organizeOptions.fileInfoIndex,
        progressCallback,
        organizeOptions.workerCount,
      )

      // Set global mappingWorkerOptions
      setMappingWorkerOptions(
        (await collectMappingOptions(organizeOptions)) as TMappingWorkerOptions,
      )

      //
      // If the request provides a directory, then use the worker
      // to recursively convert to fileSystemHandles.
      // If the request provides a list of File objects,
      // send them to the mapping workers directly.
      //
      if (
        organizeOptions.inputType === 'directory' ||
        organizeOptions.inputType === 'path' ||
        organizeOptions.inputType === 's3'
      ) {
        fileListWorker = await initializeFileListWorker(rejectCallback)

        // Wire up backpressure resume: when the dispatch loop drains the
        // queue below the low-water mark, it calls this to resume scanning.
        setScanResumeCallback(() => {
          fileListWorker!.postMessage({ request: 'resume' })
        })
        let specExcludedFiletypes: string[] | undefined
        let noDicomSignatureCheck = false
        let noDefaultExclusions = false

        if (organizeOptions.curationSpec === 'none') {
          // "none" spec means no curation at all, we just copy everything
          noDicomSignatureCheck = true
          noDefaultExclusions = true
        } else {
          const curationSpec = composeSpecs(organizeOptions.curationSpec())
          specExcludedFiletypes = curationSpec.excludedFiletypes
        }

        // Convert glob patterns to regex source strings for the worker.
        // Globs are matched against the full file path (S3 key or relative filesystem path).
        const excludedPathRegexes = organizeOptions.excludedPathGlobs?.map(
          (glob) => picomatch.makeRe(glob).source,
        )

        if (organizeOptions.inputType === 'directory') {
          fileListWorker.postMessage({
            request: 'scan',
            directoryHandle: organizeOptions.inputDirectory,
            excludedFiletypes: specExcludedFiletypes,
            excludedPathRegexes,
            noDicomSignatureCheck,
            noDefaultExclusions,
            fileInfoIndex: organizeOptions.fileInfoIndex,
          } satisfies FileScanRequest)
        } else if (organizeOptions.inputType === 's3') {
          fileListWorker.postMessage({
            request: 'scan',
            bucketOptions: organizeOptions.inputS3Bucket,
            excludedFiletypes: specExcludedFiletypes,
            excludedPathRegexes,
            fileInfoIndex: organizeOptions.fileInfoIndex,
            noDicomSignatureCheck,
            noDefaultExclusions,
          } satisfies FileScanRequest)
        } else {
          fileListWorker.postMessage({
            request: 'scan',
            path: organizeOptions.inputDirectory,
            excludedFiletypes: specExcludedFiletypes,
            excludedPathRegexes,
            fileInfoIndex: organizeOptions.fileInfoIndex,
            noDicomSignatureCheck,
            noDefaultExclusions,
          } satisfies FileScanRequest)
        }
      } else if (organizeOptions.inputType === 'files') {
        queueFilesForMapping(organizeOptions)
      } else if (organizeOptions.inputType === 'http') {
        queueUrlsForMapping(organizeOptions)
      } else {
        console.error('`inputType` does not match any supported type')
      }

      dispatchMappingJobs()
    } catch (error) {
      rejectCallback(error as Error)
    }
  })
}

// This is needed here for OUTPUT_FILE_PREFIX to also be exported by the package
export * from './types'

export { curateMany, curateOne, extractColumnMappings }
