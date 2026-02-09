import { extractColumnMappings, TColumnMappings } from './csvMapping'
import { curateOne } from './curateOne'
import { composeSpecs } from './composeSpecs'
import { serializeMappingOptions } from './serializeMappingOptions'
import { iso8601 } from './offsetDateTime'

import type {
  TMappingOptions,
  TMapResults,
  TFileInfo,
  OrganizeOptions,
  TProgressMessage,
  TProgressMessageDone,
  TPs315Options,
  THTTPOptions,
  TFileInfoIndex,
  THashMethod,
  TS3BucketOptions,
} from './types'

import type { FileScanMsg, FileScanRequest } from './scanDirectoryWorker'
import type { MappingRequest } from './applyMappingsWorker'
import { createWorker } from './worker'
import { loadS3Client } from './s3Client'

type TMappingWorkerOptions = TMappingOptions & {
  outputTarget?: {
    http?: THTTPOptions
    directory?: FileSystemDirectoryHandle | string
    s3?: TS3BucketOptions
  }
  hashMethod?: THashMethod
}

export type ProgressCallback = (message: TProgressMessage) => void

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

const mappingWorkerCount = navigator.hardwareConcurrency

// Update the type to include scan anomalies
let filesToProcess: {
  fileInfo: TFileInfo
  fileIndex: number
  scanAnomalies: string[]
  previousFileInfo?: { size?: number; mtime?: string; preMappedHash?: string }
}[] = []
let directoryScanFinished = false

// Track scan anomalies separately since they don't go through the processing pipeline
let scanAnomalies: { fileInfo: TFileInfo; anomalies: string[] }[] = []

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
async function initializeFileListWorker() {
  filesToProcess = []
  directoryScanFinished = false

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
        `Scan worker crashed: ${error instanceof ErrorEvent ? error.message : String(error)}`,
      ),
    )
  }

  fileListWorker.addEventListener(
    'message',
    (event: MessageEvent<FileScanMsg>) => {
      switch (event.data.response) {
        case 'file': {
          const { fileIndex, fileInfo, previousFileInfo } = event.data
          filesToProcess.push({
            fileIndex,
            fileInfo,
            scanAnomalies: [], // Files sent to processing have no scan anomalies
            previousFileInfo,
          })

          // Could do some throttling:
          // if (filesToProcess.length > 10) {
          //   fileListWorker.postMessage({ request: 'stop' })
          // }
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
          directoryScanFinished = true
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

//
// Apply mappings web worker management
//
// worker accepts these messages:
//   request: 'apply', fileInfo, outDirectoryHandle, mappingOptions
// worker sends these messages:
//   response: 'finished', mapResults
//
let mappingWorkerOptions: Partial<TMappingWorkerOptions> = {} // TODO: only send to worker once
const availableMappingWorkers: Worker[] = []
let workersActive = 0
let mapResultsList: TMapResults[] | undefined
let filesMapped = 0

async function initializeMappingWorkers(
  skipCollectingMappings?: boolean,
  fileInfoIndex?: TFileInfoIndex,
) {
  mappingWorkerOptions = {}
  workersActive = 0
  mapResultsList = skipCollectingMappings ? undefined : []
  filesMapped = 0

  for (let workerIndex = 0; workerIndex < mappingWorkerCount; workerIndex++) {
    let mappingWorker = await createWorker(
      new URL('./applyMappingsWorker.js', import.meta.url),
      { type: 'module' },
    )
    mappingWorker.onerror = console.error

    if (fileInfoIndex !== undefined) {
      const postMappedOnly = Object.fromEntries(
        Object.entries(fileInfoIndex).filter(
          ([key, value]) => !!value.postMappedHash,
        ),
      )

      mappingWorker.postMessage({
        request: 'fileInfoIndex',
        fileInfoIndex: postMappedOnly,
      })
    }

    mappingWorker.addEventListener('message', (event) => {
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
            totalFiles: filesToProcess.length + filesMapped + workersActive,
          })

          dispatchMappingJobs()
          if (filesMapped % 100 === 0) {
            console.log(`Finished mapping ${filesMapped} files`)
          }
          break
        case 'error':
          console.error('Error in mapping worker:', event.data.error)
          availableMappingWorkers.push(mappingWorker)
          workersActive -= 1
          filesMapped += 1
          break
        default:
          console.error(`Unknown response from worker ${event.data.response}`)
      }
    })

    availableMappingWorkers.push(mappingWorker)
  }
}

// If the TFileInfo represents an HTTP resource with dynamic headers,
// resolve the headers by calling the provider function.
async function getHttpInputHeaders(fileInfo: TFileInfo): Promise<TFileInfo> {
  if (fileInfo.kind === 'http' && typeof fileInfo.headers === 'function') {
    const clonedFileInfo: TFileInfo = { ...fileInfo }
    clonedFileInfo.headers = await fileInfo.headers()
    return clonedFileInfo
  }

  return fileInfo
}

// If the outputTarget includes HTTP with dynamic headers,
// resolve the headers by calling the provider function.
async function getHttpOutputHeaders(
  outputTarget: TMappingWorkerOptions['outputTarget'],
): Promise<TMappingWorkerOptions['outputTarget']> {
  if (outputTarget?.http && typeof outputTarget.http.headers === 'function') {
    const clonedOutputTarget: TMappingWorkerOptions['outputTarget'] = {
      ...outputTarget,
    }
    clonedOutputTarget.http = {
      ...outputTarget.http,
      headers: await outputTarget.http.headers(),
    }
    return clonedOutputTarget
  }

  return outputTarget
}

async function dispatchMappingJobs() {
  while (filesToProcess.length > 0 && availableMappingWorkers.length > 0) {
    const { fileInfo, fileIndex, previousFileInfo } = filesToProcess.pop()!
    const mappingWorker = availableMappingWorkers.pop()!
    const { outputTarget, hashMethod, ...mappingOptions } =
      // Not partial anymore.
      mappingWorkerOptions as TMappingWorkerOptions
    mappingWorker.postMessage({
      request: 'apply',
      fileInfo: await getHttpInputHeaders(fileInfo),
      fileIndex,
      outputTarget: await getHttpOutputHeaders(outputTarget),
      previousFileInfo,
      hashMethod,
      serializedMappingOptions: serializeMappingOptions(mappingOptions),
    } satisfies MappingRequest)
    workersActive += 1
  }
  if (
    workersActive === 0 &&
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

  const { dicomPS315EOptions: deIdOpts, additionalData } =
    composeSpecs(curationSpec())

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
  }
}

function queueFilesForMapping(
  organizeOptions: Extract<OrganizeOptions, { inputType: 'files' }>,
) {
  organizeOptions.inputFiles.forEach((inputFile, fileIndex) => {
    const fileInfo: TFileInfo = {
      path: '',
      name: inputFile.name,
      size: inputFile.size,
      kind: 'blob',
      blob: inputFile,
    }
    filesToProcess.push({
      fileInfo,
      fileIndex,
      scanAnomalies: [],
    })
  })
  // Dispatch jobs once after all files are queued to prevent race conditions
  dispatchMappingJobs()
}

function queueUrlsForMapping(
  organizeOptions: Extract<OrganizeOptions, { inputType: 'http' }>,
) {
  organizeOptions.inputUrls.forEach((inputUrl, fileIndex) => {
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
      fileIndex,
      scanAnomalies: [],
    })
  })

  dispatchMappingJobs()
  directoryScanFinished = true
}

let progressCallback: ProgressCallback
let rejectCallback!: (reason: Error) => void

async function curateMany(
  organizeOptions: OrganizeOptions,
  onProgress?: ProgressCallback,
): Promise<TProgressMessageDone> {
  return new Promise<TProgressMessageDone>(async (resolve, reject) => {
    // Resolve promise if progressCallback gets called with 'done'
    progressCallback = (msg) => {
      onProgress?.(msg)

      if (msg.response === 'done') {
        resolve(msg)
      }
    }

    rejectCallback = reject

    try {
      // Reset global state to prevent interference between multiple curateMany() calls
      // This is critical for two-pass curation where curateMany() is called twice
      scanAnomalies = []

      // create the mapping workers
      await initializeMappingWorkers(
        organizeOptions.skipCollectingMappings,
        organizeOptions.fileInfoIndex,
      )

      // Set global mappingWorkerOptions
      mappingWorkerOptions = (await collectMappingOptions(
        organizeOptions,
      )) as TMappingWorkerOptions

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
        const fileListWorker = await initializeFileListWorker()
        const curationSpec = composeSpecs(organizeOptions.curationSpec())
        const specExcludedFiletypes = curationSpec.excludedFiletypes

        if (organizeOptions.inputType === 'directory') {
          fileListWorker.postMessage({
            request: 'scan',
            directoryHandle: organizeOptions.inputDirectory,
            excludedFiletypes: specExcludedFiletypes,
            fileInfoIndex: organizeOptions.fileInfoIndex,
          } satisfies FileScanRequest)
        } else if (organizeOptions.inputType === 's3') {
          fileListWorker.postMessage({
            request: 'scan',
            bucketOptions: organizeOptions.inputS3Bucket,
            excludedFiletypes: specExcludedFiletypes,
            fileInfoIndex: organizeOptions.fileInfoIndex,
          } satisfies FileScanRequest)
        } else {
          fileListWorker.postMessage({
            request: 'scan',
            path: organizeOptions.inputDirectory,
            excludedFiletypes: specExcludedFiletypes,
            fileInfoIndex: organizeOptions.fileInfoIndex,
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
      reject(error)
    }
  })
}

// This is needed here for OUTPUT_FILE_PREFIX to also be exported by the package
export * from './types'

export { curateMany, curateOne, extractColumnMappings }
