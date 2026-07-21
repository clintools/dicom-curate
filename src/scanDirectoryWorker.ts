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

/**
 * Name-based exclusion decision for an S3 object key.
 *
 * Exported for testing: the S3 listing path needs a live bucket, and the worker
 * runs in its own process where the S3 client cannot be mocked.
 *
 * Unlike the filesystem paths, an S3 key carries its whole prefix while the
 * exclusion list holds bare filenames — and the defaults apply here too.
 */
export function isS3KeyExcludedByName(
  key: string,
  extraExcludedFiletypes: string[],
  includeDefaults: boolean,
): boolean {
  const objectName = key.slice(key.lastIndexOf('/') + 1)
  const allExcludedFiletypes = [
    ...(includeDefaults ? DEFAULT_EXCLUDED_FILETYPES : []),
    ...extraExcludedFiletypes,
  ]
  return allExcludedFiletypes.some(
    (excluded) => objectName.toLowerCase() === excluded.toLowerCase(),
  )
}

/**
 * Build a PHI-safe error message for a file that could not be read during
 * scanning. Only the error code/name is included — never `error.message`,
 * because node fs errors embed the full raw path in the message (e.g.
 * "ENOENT: no such file or directory, stat '/path/to/file.dcm'") and this
 * string goes into `errors`, which is shared between the private and
 * server-bound logs. The raw path/name is carried separately in `fileInfo`
 * so it appears only in the private (input) log.
 */
function safeReadErrorMessage(error: unknown): string {
  let detail = 'unknown error'
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown }
    if (typeof code === 'string' && code) {
      detail = code
    } else if (typeof name === 'string' && name) {
      detail = name
    }
  }
  return `Unable to read file (filesystem error): ${detail}`
}

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
      /**
       * Hard errors discovered during scanning (e.g. a file that cannot be
       * read at all via the FileSystem API / fs.stat). Unlike `anomalies`
       * (benign findings such as non-DICOM or too-small files), these are
       * surfaced as errors so they are visible regardless of pass. The string
       * MUST NOT contain the raw filename/path — that is carried only in
       * `fileInfo` so it stays in the private (input) log.
       */
      errors?: string[]
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

// Backpressure gate: when the main thread signals 'stop', the feeder
// awaits this promise before emitting the next file. 'resume' resolves it.
// The counter is NOT affected by backpressure — it always runs at max speed.
let pauseResolve: (() => void) | null = null
let pausePromise: Promise<void> | null = null

// --------------------------------------------------------------------------
// Shared counter — incremented by the counter goroutine (cheap filter),
// decremented by the feeder when a file fails the full filter.
// Both run in the same Web Worker so access is safe (JS is single-threaded).
// --------------------------------------------------------------------------

/** Running count of files that passed filters (cheap or full). */
let totalDiscovered = 0

// --------------------------------------------------------------------------

function pauseScanning(): void {
  if (!pausePromise) {
    pausePromise = new Promise<void>((resolve) => {
      pauseResolve = resolve
    })
  }
}

function resumeScanning(): void {
  if (pauseResolve) {
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
      isS3KeyExcludedByName(s3Item.Key, excludedFiletypes, !noDefaultExclusions)
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
// Cheap filters — used by the parallel counter and feeder correction.
// --------------------------------------------------------------------------

/**
 * Name-only filter for the counter. No file I/O required — checks only the
 * file name against exclusion lists and path against regex patterns. This
 * is the fastest possible filter since it doesn't need getFile() or stat().
 * The count may be slightly high (includes files that would fail the size
 * or DICOM signature checks). The feeder corrects as it processes files.
 */
function cheapFilterNameOnly(fileName: string, filePath: string): boolean {
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

  return true
}

// --------------------------------------------------------------------------
// Message handler
// --------------------------------------------------------------------------

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
        // Pause the feeder — the counter is NOT affected by backpressure
        pauseScanning()
        break
      }
      case 'resume': {
        // Resume the feeder
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

      // Sync totalDiscovered after each page so the main thread's
      // totalFiles stays ahead of processedFiles during listing.
      globalThis.postMessage({
        response: 'count',
        totalDiscovered,
      } satisfies FileScanMsg)

      // Prepare for next page
      continuationToken = data.NextContinuationToken as string | undefined
    } while (continuationToken)

    // Final count sync before done
    globalThis.postMessage({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
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

// --------------------------------------------------------------------------
// Browser path: FileSystemDirectoryHandle
// --------------------------------------------------------------------------

async function scanDirectory(dir: FileSystemDirectoryHandle) {
  /**
   * Counter: traverses the directory tree using only readdir + name filter.
   * Does NOT call getFile() or read file contents — only checks entry.kind
   * and file name against exclusion lists. This is the fastest possible
   * traversal. Emits 'count' messages at max speed so the main thread has
   * an accurate total early. The feeder corrects the estimate as it
   * processes files with the full filter.
   */
  async function counter(
    dirHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const entry of dirHandle.values()) {
      if (!keepScanning) return

      if (entry.kind === 'file') {
        const key = `${prefix}/${entry.name}`

        if (cheapFilterNameOnly(entry.name, key)) {
          totalDiscovered++
          globalThis.postMessage({
            response: 'count',
            totalDiscovered,
          } satisfies FileScanMsg)
        }
      } else if (entry.kind === 'directory') {
        await counter(
          entry as FileSystemDirectoryHandle,
          prefix + '/' + entry.name,
        )
      }
    }
  }

  /**
   * Feeder: traverses the directory tree with the full filter (including
   * DICOM signature check). Emits 'file' messages. Subject to backpressure
   * (pause/resume from the main thread). When a file fails the full filter
   * but would have passed the cheap filter, decrements totalDiscovered and
   * emits a corrected 'count' to fix the counter's estimate.
   */
  async function feeder(
    dirHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const entry of dirHandle.values()) {
      if (!keepScanning) return

      if (entry.kind === 'file') {
        const key = `${prefix}/${entry.name}`
        const prev = previousIndex ? previousIndex[key] : undefined

        let file: File
        try {
          file = await (entry as FileSystemFileHandle).getFile()
        } catch (readError) {
          // A single file we cannot read (corrupted, locked, permission
          // revoked via the Chromium FileSystem API) must NOT abort the whole
          // scan. Report it as a hard error and continue. The error string is
          // PHI-safe (no filename); the raw path/name lives only in fileInfo,
          // which keeps it in the private (input) log.
          if (cheapFilterNameOnly(entry.name, key)) {
            totalDiscovered--
            globalThis.postMessage({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: 0,
              kind: 'handle',
              fileHandle: entry as FileSystemFileHandle,
            },
            anomalies: [],
            errors: [safeReadErrorMessage(readError)],
            previousFileInfo: prev,
          } satisfies FileScanMsg)
          if (!(await waitIfPaused())) return
          continue
        }

        const fileAnomalies: string[] = []
        if (await shouldProcessFile(file, fileAnomalies, key)) {
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
        } else {
          // File failed full filter. If it would have passed the counter's
          // name-only filter, the counter already counted it — correct.
          if (cheapFilterNameOnly(entry.name, key)) {
            totalDiscovered--
            globalThis.postMessage({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
          if (fileAnomalies.length > 0) {
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
        }

        // Backpressure: may pause the feeder for memory control
        if (!(await waitIfPaused())) return
      } else if (entry.kind === 'directory') {
        await feeder(
          entry as FileSystemDirectoryHandle,
          prefix + '/' + entry.name,
        )
      }
    }
  }

  try {
    // Run counter and feeder concurrently. The counter finishes first
    // (~8x faster), giving an accurate total. The feeder runs for the
    // duration of processing, subject to backpressure.
    await Promise.all([counter(dir, dir.name), feeder(dir, dir.name)])

    // Final count sync — at this point totalDiscovered is exact
    // (counter finished + feeder corrections applied).
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

// --------------------------------------------------------------------------
// Node path: filesystem paths
// --------------------------------------------------------------------------

async function scanDirectoryNode(dirPath: string) {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    /**
     * Counter: traverses using readdir + name filter only.
     * No stat() calls — just checks file name against exclusion lists.
     * Emits 'count' at max speed.
     */
    async function counter(currentPath: string, prefix: string): Promise<void> {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (!keepScanning) return

        if (entry.isFile()) {
          const key = `${prefix}/${entry.name}`

          if (cheapFilterNameOnly(entry.name, key)) {
            totalDiscovered++
            globalThis.postMessage({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
        } else if (entry.isDirectory()) {
          await counter(
            path.join(currentPath, entry.name),
            prefix + '/' + entry.name,
          )
        }
      }
    }

    /**
     * Feeder: traverses with full filter (DICOM signature check).
     * Emits 'file' messages. Subject to backpressure. Corrects the
     * counter's estimate when files fail the full filter.
     */
    async function feeder(currentPath: string, prefix: string): Promise<void> {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (!keepScanning) return

        if (entry.isFile()) {
          const filePath = path.join(currentPath, entry.name)
          const key = `${prefix}/${entry.name}`
          const prev = previousIndex ? previousIndex[key] : undefined

          let stats: Awaited<ReturnType<typeof fs.stat>>
          try {
            stats = await fs.stat(filePath)
          } catch (readError) {
            // A single file we cannot stat (vanished, permission denied) must
            // NOT abort the whole scan. Report it as a hard error and continue.
            // The error string is PHI-safe (no path); the raw path lives only
            // in fileInfo, keeping it in the private (input) log.
            if (cheapFilterNameOnly(entry.name, key)) {
              totalDiscovered--
              globalThis.postMessage({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            globalThis.postMessage({
              response: 'scanAnomalies',
              fileInfo: {
                path: prefix,
                name: entry.name,
                size: 0,
                kind: 'path',
                fullPath: filePath,
              },
              anomalies: [],
              errors: [safeReadErrorMessage(readError)],
              previousFileInfo: prev,
            } satisfies FileScanMsg)
            if (!(await waitIfPaused())) return
            continue
          }

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
          } else {
            // Correct the counter's estimate if needed
            if (cheapFilterNameOnly(entry.name, key)) {
              totalDiscovered--
              globalThis.postMessage({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            if (fileAnomalies.length > 0) {
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
          }

          // Backpressure: may pause the feeder for memory control
          if (!(await waitIfPaused())) return
        } else if (entry.isDirectory()) {
          await feeder(
            path.join(currentPath, entry.name),
            prefix + '/' + entry.name,
          )
        }
      }
    }

    const dirName = path.basename(dirPath)

    // Run counter and feeder concurrently
    await Promise.all([counter(dirPath, dirName), feeder(dirPath, dirName)])

    // Final count sync
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
