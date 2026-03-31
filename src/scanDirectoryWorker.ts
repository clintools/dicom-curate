import { loadS3Client } from './s3Client'
import type { TFileInfo, TFileInfoIndex, TS3BucketOptions } from './types'
import { fixupNodeWorkerEnvironment } from './worker'

// Case-insensitive filetypes to ALWAYS exclude from processing
const DEFAULT_EXCLUDED_FILETYPES = [
  'dicomdir',
  'dicomdir.dir',
  'dicomdir.dat',
  'dicomdir.bak',
  'thumbs.db',
  '.ds_store',
]

export type FileScanMsg =
  | {
      response: 'file'
      fileInfo: TFileInfo
      previousFileInfo?: {
        size?: number
        mtime?: string
        preMappedHash?: string
      }
    }
  | {
      response: 'scanAnomalies'
      fileInfo: TFileInfo
      anomalies: string[]
      previousFileInfo?: {
        size?: number
        mtime?: string
        preMappedHash?: string
      }
    }
  | {
      response: 'error'
      error: string
    }
  | {
      response: 'count'
      totalDiscovered: number
    }
  | {
      response: 'done'
    }

type CommonFileScanRequestFields = {
  excludedFiletypes?: string[]
  excludedPathRegexes?: string[]
  fileInfoIndex?: TFileInfoIndex

  noDefaultExclusions?: boolean
  noDicomSignatureCheck?: boolean
}

export type FileScanRequest =
  | ({
      request: 'scan'
      directoryHandle: FileSystemDirectoryHandle
    } & CommonFileScanRequestFields)
  | ({
      request: 'scan'
      path: string
    } & CommonFileScanRequestFields)
  | ({
      request: 'scan'
      bucketOptions: TS3BucketOptions
    } & CommonFileScanRequestFields)
  | {
      request: 'stop'
    }
  | {
      request: 'resume'
    }

let keepScanning = true

// Backpressure gate: when the main thread signals 'stop', the scan worker
// awaits this promise before emitting the next file. 'resume' resolves it.
let pauseResolve: (() => void) | null = null
let pausePromise: Promise<void> | null = null

// --------------------------------------------------------------------------
// Count-while-paused state
// --------------------------------------------------------------------------

/** Running count of files that passed filters (cheap or full). */
let totalDiscovered = 0

/**
 * When true the scanner continues traversing and counting but does NOT emit
 * 'file' messages. Instead it buffers lightweight file references and emits
 * 'count' messages so the main thread can show accurate progress.
 */
let countingMode = false

// Buffer types — store references, NOT file content.
type BufferedHandleFile = {
  kind: 'handle'
  entry: FileSystemFileHandle
  file: File
  prefix: string
  name: string
  size: number
  prev: { size?: number; mtime?: string; preMappedHash?: string } | undefined
}

type BufferedPathFile = {
  kind: 'path'
  filePath: string
  name: string
  size: number
  prefix: string
  prev: { size?: number; mtime?: string; preMappedHash?: string } | undefined
}

type BufferedFile = BufferedHandleFile | BufferedPathFile
const fileBuffer: BufferedFile[] = []

// --------------------------------------------------------------------------

function pauseScanning(): void {
  if (!pausePromise) {
    countingMode = true
    pausePromise = new Promise<void>((resolve) => {
      pauseResolve = resolve
    })
  }
}

function resumeScanning(): void {
  if (pauseResolve) {
    countingMode = false
    pauseResolve()
    pauseResolve = null
    pausePromise = null
  }
}

/** If paused, wait until resumed. Returns false if scanning was aborted. */
async function waitIfPaused(): Promise<boolean> {
  if (pausePromise) {
    await pausePromise
  }
  return keepScanning
}

let excludedFiletypes: string[] = []
// Compiled regexes from glob patterns, used to exclude files by path
let excludedPathRegexes: RegExp[] = []
let noDicomSignatureCheck = false
let noDefaultExclusions = false
// optional map of previous file info keyed by "path/name"
let previousIndex: Record<string, { size?: number; mtime?: string }> | undefined

/**
 * Check if a file should be processed based on filtering rules
 * @param file - The file to check
 * @param fileAnomalies - Array to collect anomalies for this specific file e.g. excluded files
 * @returns Promise<boolean> - True if the file should be processed
 */
async function shouldProcessFile(
  file: File,
  fileAnomalies: string[],
  filePath: string,
): Promise<boolean> {
  const allExcludedFiletypes = [
    ...(noDefaultExclusions ? [] : DEFAULT_EXCLUDED_FILETYPES),
    ...excludedFiletypes,
  ]

  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (excludedPathRegexes.some((regex) => regex.test(filePath))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      allExcludedFiletypes.some(
        (excluded) => file.name.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${file.name}`)
      return false
    }

    if (noDicomSignatureCheck) {
      return true
    }
    // Only DICOM checks below this point

    // Check filesize - (valid) DICOM files are at least 132 bytes (128-byte preamble + 4-byte signature)
    if (file.size < 132) {
      fileAnomalies.push(
        `Skipped very small file: ${file.name} (${file.size} bytes)`,
      )
      return false
    }

    // Check for DICOM signature "DICM" at offset 128
    const headerBytes = await file.slice(128, 132).arrayBuffer()
    const headerView = new Uint8Array(headerBytes)
    const dicomSignature = String.fromCharCode(
      headerView[0],
      headerView[1],
      headerView[2],
      headerView[3],
    )
    if (dicomSignature === 'DICM') {
      return true
    }

    // Don't parse file without DICOM signature
    fileAnomalies.push(`Skipped file without DICOM signature: ${file.name}`)
    return false
  } catch (error) {
    fileAnomalies.push(
      `Unable to determine file validity - processing anyway: ${file.name} - ${error}`,
    )
    // If vetting process fails, let the parser decide
    return true
  }
}

async function shouldProcessFileItem(
  s3Item: any,
  fileAnomalies: string[],
): Promise<boolean> {
  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (excludedPathRegexes.some((regex) => regex.test(s3Item.Key))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      excludedFiletypes.some(
        (excluded) => s3Item.Key.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${s3Item.Key}`)
      return false
    }

    if (noDicomSignatureCheck) {
      return true
    }
    // Only DICOM checks below this point

    // Check filesize - (valid) DICOM files are at least 132 bytes (128-byte preamble + 4-byte signature)
    if (s3Item.Size < 132) {
      fileAnomalies.push(
        `Skipped very small file: ${s3Item.Key} (${s3Item.Size} bytes)`,
      )
      return false
    }

    // Note: We cannot check for DICOM signature without downloading the object,
    // so we skip that check here and let the parser decide later.

    return true
  } catch (error) {
    fileAnomalies.push(
      `Unable to determine file validity - processing anyway: ${s3Item.Key} - ${error}`,
    )
    // If vetting process fails, let the parser decide
    return true
  }
}

/**
 * Node-specific file validation that reads only the bytes needed
 * instead of loading the entire file into memory.
 */
async function shouldProcessFileNode(
  filePath: string,
  fileName: string,
  fileSize: number,
  fileAnomalies: string[],
  relativePath: string,
): Promise<boolean> {
  const allExcludedFiletypes = [
    ...(noDefaultExclusions ? [] : DEFAULT_EXCLUDED_FILETYPES),
    ...excludedFiletypes,
  ]

  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (excludedPathRegexes.some((regex) => regex.test(relativePath))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      allExcludedFiletypes.some(
        (excluded) => fileName.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${fileName}`)
      return false
    }

    if (noDicomSignatureCheck) {
      return true
    }
    // Only DICOM checks below this point

    // Check filesize - (valid) DICOM files are at least 132 bytes (128-byte preamble + 4-byte signature)
    if (fileSize < 132) {
      fileAnomalies.push(
        `Skipped very small file: ${fileName} (${fileSize} bytes)`,
      )
      return false
    }

    // Check for DICOM signature "DICM" at offset 128 by reading only 4 bytes
    const fs = await import('fs/promises')
    const fh = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(4)
      await fh.read(buffer, 0, 4, 128)
      const dicomSignature = buffer.toString('ascii')
      if (dicomSignature === 'DICM') {
        return true
      }
    } finally {
      await fh.close()
    }

    // Don't parse file without DICOM signature
    fileAnomalies.push(`Skipped file without DICOM signature: ${fileName}`)
    return false
  } catch (error) {
    fileAnomalies.push(
      `Unable to determine file validity - processing anyway: ${fileName} - ${error}`,
    )
    // If vetting process fails, let the parser decide
    return true
  }
}

// --------------------------------------------------------------------------
// Cheap filters — used during counting mode. These skip the DICOM signature
// check (which requires opening/reading the file) and only apply metadata-
// based filters: path regex, filename exclusion, and size.
// --------------------------------------------------------------------------

/**
 * Cheap filter for browser Handle path. Requires a File object (from
 * entry.getFile()) for the size, but does NOT open/read file contents.
 * Returns true if the file should be counted.
 */
function cheapFilter(
  fileName: string,
  fileSize: number,
  filePath: string,
): boolean {
  const allExcludedFiletypes = [
    ...(noDefaultExclusions ? [] : DEFAULT_EXCLUDED_FILETYPES),
    ...excludedFiletypes,
  ]

  // Check if the file path matches any excluded path patterns (silent skip)
  if (excludedPathRegexes.some((regex) => regex.test(filePath))) {
    return false
  }

  // Check if the file is in the list of excluded files
  if (
    allExcludedFiletypes.some(
      (excluded) => fileName.toLowerCase() === excluded.toLowerCase(),
    )
  ) {
    return false
  }

  // If DICOM signature check is disabled, this is the only check we'd do
  // anyway, so the count is exact.
  if (noDicomSignatureCheck) {
    return true
  }

  // Check filesize — files below 132 bytes can't be valid DICOM
  if (fileSize < 132) {
    return false
  }

  // Can't check DICOM signature without reading — assume it passes for now.
  // The count self-corrects during buffer drain when the full filter runs.
  return true
}

// --------------------------------------------------------------------------
// Buffer drain — emit 'file' for each buffered entry, running the FULL
// filter (including DICOM signature check). If a file fails, decrement
// totalDiscovered and emit a corrected 'count'. Backpressure may re-engage
// mid-drain, in which case we stop draining and return to counting mode.
// --------------------------------------------------------------------------

async function drainBuffer(): Promise<void> {
  while (fileBuffer.length > 0 && keepScanning) {
    const item = fileBuffer.shift()!
    const fileAnomalies: string[] = []

    if (item.kind === 'handle') {
      const filePath = `${item.prefix}/${item.name}`
      if (await shouldProcessFile(item.file, fileAnomalies, filePath)) {
        globalThis.postMessage({
          response: 'file',
          fileInfo: {
            path: item.prefix,
            name: item.name,
            size: item.size,
            kind: 'handle',
            fileHandle: item.entry,
          },
          previousFileInfo: item.prev,
        } satisfies FileScanMsg)
      } else {
        // File failed full filter — correct the count
        totalDiscovered--
        globalThis.postMessage({
          response: 'count',
          totalDiscovered,
        } satisfies FileScanMsg)
        if (fileAnomalies.length > 0) {
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileInfo: {
              path: item.prefix,
              name: item.name,
              size: item.size,
              kind: 'handle',
              fileHandle: item.entry,
            },
            anomalies: fileAnomalies,
            previousFileInfo: item.prev,
          } satisfies FileScanMsg)
        }
      }
    } else {
      // kind === 'path'
      if (
        await shouldProcessFileNode(
          item.filePath,
          item.name,
          item.size,
          fileAnomalies,
          `${item.prefix}/${item.name}`,
        )
      ) {
        globalThis.postMessage({
          response: 'file',
          fileInfo: {
            path: item.prefix,
            name: item.name,
            size: item.size,
            kind: 'path',
            fullPath: item.filePath,
          },
          previousFileInfo: item.prev,
        } satisfies FileScanMsg)
      } else {
        // File failed full filter — correct the count
        totalDiscovered--
        globalThis.postMessage({
          response: 'count',
          totalDiscovered,
        } satisfies FileScanMsg)
        if (fileAnomalies.length > 0) {
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileInfo: {
              path: item.prefix,
              name: item.name,
              size: item.size,
              kind: 'path',
              fullPath: item.filePath,
            },
            anomalies: fileAnomalies,
            previousFileInfo: item.prev,
          } satisfies FileScanMsg)
        }
      }
    }

    // Backpressure may re-engage during drain
    if (!(await waitIfPaused())) return
    // If re-paused during drain, stop draining and return to counting mode
    if (countingMode) return
  }
}

fixupNodeWorkerEnvironment().then(() => {
  globalThis.addEventListener('message', (event) => {
    switch (event.data.request) {
      case 'scan': {
        const eventData = event.data as FileScanRequest

        // Optional previous file info index passed in by caller
        if (event.data.fileInfoIndex) {
          previousIndex = event.data.fileInfoIndex
        } else {
          previousIndex = undefined
        }
        // Update excluded filetypes if provided
        if (event.data.excludedFiletypes) {
          excludedFiletypes = event.data.excludedFiletypes
        }
        // Compile excluded path regex strings (converted from globs in the main thread)
        if (event.data.excludedPathRegexes) {
          excludedPathRegexes = event.data.excludedPathRegexes.map(
            (pattern: string) => new RegExp(pattern),
          )
        } else {
          excludedPathRegexes = []
        }
        noDicomSignatureCheck = event.data.noDicomSignatureCheck ?? false
        noDefaultExclusions = event.data.noDefaultExclusions ?? false
        keepScanning = true

        // Reset counting state for new scan
        totalDiscovered = 0
        countingMode = false
        fileBuffer.length = 0

        if ('path' in eventData) {
          scanDirectoryNode(eventData.path)
        } else if ('directoryHandle' in eventData) {
          scanDirectory(eventData.directoryHandle)
        } else if ('bucketOptions' in eventData) {
          scanS3Bucket(eventData.bucketOptions)
        } else {
          console.error('No valid directory information provided for scanning.')
        }
        break
      }
      case 'stop': {
        // Pause scanning — the scan loop will await waitIfPaused()
        pauseScanning()
        break
      }
      case 'resume': {
        // Resume scanning after a pause
        resumeScanning()
        break
      }
      default:
        console.error(`Unknown request ${event.data.request}`)
    }
  })
})

async function scanS3Bucket(bucketOptions: TS3BucketOptions) {
  try {
    const s3 = await loadS3Client()

    const client = new s3.S3Client({
      region: bucketOptions.region,
      credentials: bucketOptions.credentials,
      endpoint: bucketOptions.endpoint,
      forcePathStyle: bucketOptions.forcePathStyle,
    })

    // Page through the S3 bucket listing using ContinuationToken
    let continuationToken: string | undefined

    do {
      const listCommand = new s3.ListObjectsV2Command({
        Bucket: bucketOptions.bucketName,
        Prefix: bucketOptions.prefix,
        ContinuationToken: continuationToken,
      })

      const data = await client.send(listCommand)

      if (data.Contents) {
        for (const item of data.Contents) {
          const fileAnomalies: string[] = []

          if (
            item.Key &&
            item.Size !== undefined &&
            (await shouldProcessFileItem(item, fileAnomalies))
          ) {
            totalDiscovered++
            const prev = previousIndex ? previousIndex[item.Key] : undefined

            globalThis.postMessage({
              response: 'file',
              fileInfo: {
                size: item.Size,
                name: item.Key,
                path: item.Key,
                objectKey: item.Key,
                bucketOptions,
                kind: 's3',
              },
              previousFileInfo: prev,
            } satisfies FileScanMsg)
          } else if (fileAnomalies.length > 0) {
            const prev = previousIndex ? previousIndex[item.Key!] : undefined
            globalThis.postMessage({
              response: 'scanAnomalies',
              fileInfo: {
                size: item.Size!,
                name: item.Key!,
                path: item.Key!,
                objectKey: item.Key!,
                bucketOptions,
                kind: 's3',
              },
              anomalies: fileAnomalies,
              previousFileInfo: prev,
            } satisfies FileScanMsg)
          }
        }
      }

      // Prepare for next page
      continuationToken = data.NextContinuationToken as string | undefined
    } while (continuationToken)

    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `S3 bucket scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}

async function scanDirectory(dir: FileSystemDirectoryHandle) {
  async function traverse(
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const entry of dir.values()) {
      if (!keepScanning) return

      if (entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile()
        const key = `${prefix}/${entry.name}`
        const prev = previousIndex ? previousIndex[key] : undefined

        if (countingMode) {
          // Counting mode: cheap filter only, buffer the reference
          if (cheapFilter(entry.name, file.size, key)) {
            totalDiscovered++
            fileBuffer.push({
              kind: 'handle',
              entry: entry as FileSystemFileHandle,
              file,
              prefix,
              name: entry.name,
              size: file.size,
              prev,
            })
            globalThis.postMessage({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
          // In counting mode we don't emit scanAnomalies for cheap-filter
          // rejects — they'll be handled during drain if they were buffered,
          // or are genuinely excluded (no anomaly to report).
          continue
        }

        // Feeding mode: drain any buffered files first
        if (fileBuffer.length > 0) {
          await drainBuffer()
          // Drain may have re-engaged counting mode
          if (countingMode) {
            // Re-process this entry in counting mode on next iteration
            // We can't easily "unget" a for-await entry, so handle it here
            if (cheapFilter(entry.name, file.size, key)) {
              totalDiscovered++
              fileBuffer.push({
                kind: 'handle',
                entry: entry as FileSystemFileHandle,
                file,
                prefix,
                name: entry.name,
                size: file.size,
                prev,
              })
              globalThis.postMessage({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            continue
          }
        }

        // Normal feeding path: full filter, emit 'file'
        const fileAnomalies: string[] = []
        if (await shouldProcessFile(file, fileAnomalies, key)) {
          totalDiscovered++
          globalThis.postMessage({
            response: 'file',
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: file.size,
              kind: 'handle',
              fileHandle: entry as FileSystemFileHandle,
            },
            previousFileInfo: prev,
          } satisfies FileScanMsg)
          // Periodically sync totalDiscovered with the main thread so
          // progress reporting stays accurate after exiting counting mode.
          if (totalDiscovered % 100 === 0) {
            globalThis.postMessage({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
        } else if (fileAnomalies.length > 0) {
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: file.size,
              kind: 'handle',
              fileHandle: entry as FileSystemFileHandle,
            },
            anomalies: fileAnomalies,
            previousFileInfo: prev,
          } satisfies FileScanMsg)
        }

        // Backpressure: may flip to counting mode for next iteration
        if (!(await waitIfPaused())) return
      } else if (entry.kind === 'directory') {
        await traverse(
          entry as FileSystemDirectoryHandle,
          prefix + '/' + entry.name,
        )
      }
    }
  }

  try {
    await traverse(dir, dir.name)
    // Drain any remaining buffered files before signalling done
    if (fileBuffer.length > 0) {
      countingMode = false
      await drainBuffer()
    }
    // Final count sync so the main thread has the exact total before 'done'
    globalThis.postMessage({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}

// This function is identical to scanDirectory but works with real filesystem
// paths instead of FileSystemDirectoryHandles
async function scanDirectoryNode(dirPath: string) {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    async function traverse(
      currentPath: string,
      prefix: string,
    ): Promise<void> {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (!keepScanning) return

        if (entry.isFile()) {
          const filePath = path.join(currentPath, entry.name)
          const stats = await fs.stat(filePath)
          const key = `${prefix}/${entry.name}`
          const prev = previousIndex ? previousIndex[key] : undefined

          if (countingMode) {
            // Counting mode: cheap filter only, buffer the reference
            if (cheapFilter(entry.name, stats.size, key)) {
              totalDiscovered++
              fileBuffer.push({
                kind: 'path',
                filePath,
                name: entry.name,
                size: stats.size,
                prefix,
                prev,
              })
              globalThis.postMessage({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            continue
          }

          // Feeding mode: drain any buffered files first
          if (fileBuffer.length > 0) {
            await drainBuffer()
            // Drain may have re-engaged counting mode
            if (countingMode) {
              if (cheapFilter(entry.name, stats.size, key)) {
                totalDiscovered++
                fileBuffer.push({
                  kind: 'path',
                  filePath,
                  name: entry.name,
                  size: stats.size,
                  prefix,
                  prev,
                })
                globalThis.postMessage({
                  response: 'count',
                  totalDiscovered,
                } satisfies FileScanMsg)
              }
              continue
            }
          }

          // Normal feeding path: full filter, emit 'file'
          const fileAnomalies: string[] = []
          if (
            await shouldProcessFileNode(
              filePath,
              entry.name,
              stats.size,
              fileAnomalies,
              key,
            )
          ) {
            totalDiscovered++
            globalThis.postMessage({
              response: 'file',
              fileInfo: {
                path: prefix,
                name: entry.name,
                size: stats.size,
                kind: 'path',
                fullPath: filePath,
              },
              previousFileInfo: prev,
            } satisfies FileScanMsg)
            // Periodically sync totalDiscovered with the main thread so
            // progress reporting stays accurate after exiting counting mode.
            if (totalDiscovered % 100 === 0) {
              globalThis.postMessage({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
          } else if (fileAnomalies.length > 0) {
            globalThis.postMessage({
              response: 'scanAnomalies',
              fileInfo: {
                path: prefix,
                name: entry.name,
                size: stats.size,
                kind: 'path',
                fullPath: filePath,
              },
              anomalies: fileAnomalies,
              previousFileInfo: prev,
            } satisfies FileScanMsg)
          }

          // Backpressure: may flip to counting mode for next iteration
          if (!(await waitIfPaused())) return
        } else if (entry.isDirectory()) {
          await traverse(
            path.join(currentPath, entry.name),
            prefix + '/' + entry.name,
          )
        }
      }
    }

    const dirName = await import('path').then((p) => p.basename(dirPath))
    await traverse(dirPath, dirName)
    // Drain any remaining buffered files before signalling done
    if (fileBuffer.length > 0) {
      countingMode = false
      await drainBuffer()
    }
    // Final count sync so the main thread has the exact total before 'done'
    globalThis.postMessage({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}
