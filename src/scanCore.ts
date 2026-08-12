import { loadS3Client } from './s3Client'
import type { TFileInfo, TFileInfoIndex, TS3BucketOptions } from './types'

/**
 * Thread-agnostic scanning logic. Kept out of scanDirectoryWorker.ts so it can
 * be unit-tested in-process — Vitest's v8 provider cannot attribute coverage to
 * code running inside a worker_threads child.
 */

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
export function safeReadErrorMessage(error: unknown): string {
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

/** Callback used by the traversals to emit results to the main thread. */
export type ScanEmit = (msg: FileScanMsg) => void

/** Previous file info keyed by "path/name", used to attach previousFileInfo. */
export type PreviousFileIndex = Record<
  string,
  { size?: number; mtime?: string }
>

/**
 * Filtering rules for a scan. The path regexes are pre-compiled by the caller
 * (the worker converts glob patterns to regex strings on the main thread).
 */
export type ScanFilters = {
  excludedFiletypes: string[]
  excludedPathRegexes: RegExp[]
  noDicomSignatureCheck: boolean
  noDefaultExclusions: boolean
}

/** Per-scan context handed to the traversal functions. */
export type ScanContext = {
  filters: ScanFilters
  controller: ScanController
  previousIndex?: PreviousFileIndex
  emit: ScanEmit
}

/**
 * Backpressure and abort state for a single scan.
 *
 * When the main thread signals 'stop', the feeder awaits {@link waitIfPaused}
 * before emitting the next file; 'resume' releases it. The counter is NOT
 * affected by backpressure — it always runs at max speed.
 */
export class ScanController {
  keepScanning = true
  private pauseResolve: (() => void) | null = null
  private pausePromise: Promise<void> | null = null

  pause(): void {
    if (!this.pausePromise) {
      this.pausePromise = new Promise<void>((resolve) => {
        this.pauseResolve = resolve
      })
    }
  }

  resume(): void {
    if (this.pauseResolve) {
      this.pauseResolve()
      this.pauseResolve = null
      this.pausePromise = null
    }
  }

  /** If paused, wait until resumed. Returns false if scanning was aborted. */
  async waitIfPaused(): Promise<boolean> {
    if (this.pausePromise) {
      await this.pausePromise
    }
    return this.keepScanning
  }
}

function allExcludedFiletypes(filters: ScanFilters): string[] {
  return [
    ...(filters.noDefaultExclusions ? [] : DEFAULT_EXCLUDED_FILETYPES),
    ...filters.excludedFiletypes,
  ]
}

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
  filters: ScanFilters,
): Promise<boolean> {
  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (filters.excludedPathRegexes.some((regex) => regex.test(filePath))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      allExcludedFiletypes(filters).some(
        (excluded) => file.name.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${file.name}`)
      return false
    }

    if (filters.noDicomSignatureCheck) {
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

export async function shouldProcessFileItem(
  s3Item: any,
  fileAnomalies: string[],
  filters: ScanFilters,
): Promise<boolean> {
  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (filters.excludedPathRegexes.some((regex) => regex.test(s3Item.Key))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      isS3KeyExcludedByName(
        s3Item.Key,
        filters.excludedFiletypes,
        !filters.noDefaultExclusions,
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${s3Item.Key}`)
      return false
    }

    if (filters.noDicomSignatureCheck) {
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
  filters: ScanFilters,
): Promise<boolean> {
  try {
    // Check if the file path matches any excluded path patterns (silent skip)
    if (filters.excludedPathRegexes.some((regex) => regex.test(relativePath))) {
      return false
    }

    // Check if the file is in the list of excluded files
    if (
      allExcludedFiletypes(filters).some(
        (excluded) => fileName.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${fileName}`)
      return false
    }

    if (filters.noDicomSignatureCheck) {
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
export function cheapFilterNameOnly(
  fileName: string,
  filePath: string,
  filters: ScanFilters,
): boolean {
  // Check if the file path matches any excluded path patterns (silent skip)
  if (filters.excludedPathRegexes.some((regex) => regex.test(filePath))) {
    return false
  }

  // Check if the file is in the list of excluded files
  if (
    allExcludedFiletypes(filters).some(
      (excluded) => fileName.toLowerCase() === excluded.toLowerCase(),
    )
  ) {
    return false
  }

  return true
}

// --------------------------------------------------------------------------
// S3 path: bucket listing
// --------------------------------------------------------------------------

export async function scanS3Bucket(
  bucketOptions: TS3BucketOptions,
  ctx: ScanContext,
): Promise<void> {
  const { filters, previousIndex, emit } = ctx
  let totalDiscovered = 0
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
            (await shouldProcessFileItem(item, fileAnomalies, filters))
          ) {
            totalDiscovered++
            const prev = previousIndex ? previousIndex[item.Key] : undefined

            emit({
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
            emit({
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
      emit({
        response: 'count',
        totalDiscovered,
      } satisfies FileScanMsg)

      // Prepare for next page
      continuationToken = data.NextContinuationToken as string | undefined
    } while (continuationToken)

    // Final count sync before done
    emit({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
    emit({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    emit({
      response: 'error',
      error: `S3 bucket scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  }
}

// --------------------------------------------------------------------------
// Browser path: FileSystemDirectoryHandle
// --------------------------------------------------------------------------

export async function scanDirectory(
  dir: FileSystemDirectoryHandle,
  ctx: ScanContext,
): Promise<void> {
  const { filters, controller, previousIndex, emit } = ctx
  // Shared by the counter and feeder below, which run interleaved via
  // Promise.all. Access is safe because both run in the same worker and JS is
  // single-threaded; the counter increments, the feeder decrements on files
  // that fail the full filter.
  let totalDiscovered = 0

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
      if (!controller.keepScanning) return

      if (entry.kind === 'file') {
        const key = `${prefix}/${entry.name}`

        if (cheapFilterNameOnly(entry.name, key, filters)) {
          totalDiscovered++
          emit({
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
      if (!controller.keepScanning) return

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
          if (cheapFilterNameOnly(entry.name, key, filters)) {
            totalDiscovered--
            emit({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
          emit({
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
          if (!(await controller.waitIfPaused())) return
          continue
        }

        const fileAnomalies: string[] = []
        if (await shouldProcessFile(file, fileAnomalies, key, filters)) {
          emit({
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
          if (cheapFilterNameOnly(entry.name, key, filters)) {
            totalDiscovered--
            emit({
              response: 'count',
              totalDiscovered,
            } satisfies FileScanMsg)
          }
          if (fileAnomalies.length > 0) {
            emit({
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
        if (!(await controller.waitIfPaused())) return
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
    emit({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
    emit({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    emit({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  }
}

// --------------------------------------------------------------------------
// Node path: filesystem paths
// --------------------------------------------------------------------------

export async function scanDirectoryNode(
  dirPath: string,
  ctx: ScanContext,
): Promise<void> {
  const { filters, controller, previousIndex, emit } = ctx
  // Shared by the counter and feeder below, which run interleaved via
  // Promise.all. Access is safe because both run in the same worker and JS is
  // single-threaded; the counter increments, the feeder decrements on files
  // that fail the full filter.
  let totalDiscovered = 0

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
        if (!controller.keepScanning) return

        if (entry.isFile()) {
          const key = `${prefix}/${entry.name}`

          if (cheapFilterNameOnly(entry.name, key, filters)) {
            totalDiscovered++
            emit({
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
        if (!controller.keepScanning) return

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
            if (cheapFilterNameOnly(entry.name, key, filters)) {
              totalDiscovered--
              emit({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            emit({
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
            if (!(await controller.waitIfPaused())) return
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
              filters,
            )
          ) {
            emit({
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
            if (cheapFilterNameOnly(entry.name, key, filters)) {
              totalDiscovered--
              emit({
                response: 'count',
                totalDiscovered,
              } satisfies FileScanMsg)
            }
            if (fileAnomalies.length > 0) {
              emit({
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
          if (!(await controller.waitIfPaused())) return
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
    emit({
      response: 'count',
      totalDiscovered,
    } satisfies FileScanMsg)
    emit({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    emit({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  }
}

/** Thread bindings a worker entry point supplies to the message handler. */
export type ScanHandlerBindings = {
  emit: ScanEmit
  /** Close the port once a traversal settles, so the worker can be torn down. */
  close: () => void
}

/**
 * Build the worker's message handler: filter defaulting, traversal selection
 * and backpressure dispatch. Kept out of scanDirectoryWorker.ts so it can be
 * unit-tested in-process.
 */
export function createScanHandler({ emit, close }: ScanHandlerBindings) {
  // Controller for the scan in flight, so 'stop'/'resume' can act on it. One
  // scan per worker: the port closes when the traversal settles, so this is
  // cleared on settle rather than ever being replaced by a second scan.
  let currentController: ScanController | null = null

  function handleMessage(event: MessageEvent<FileScanRequest>): void {
    switch (event.data.request) {
      case 'scan': {
        const eventData = event.data

        const previousIndex = eventData.fileInfoIndex as
          | PreviousFileIndex
          | undefined

        const filters: ScanFilters = {
          excludedFiletypes: eventData.excludedFiletypes ?? [],
          // Compile excluded path regex strings (converted from globs in the main thread)
          excludedPathRegexes: (eventData.excludedPathRegexes ?? []).map(
            (pattern: string) => new RegExp(pattern),
          ),
          noDicomSignatureCheck: eventData.noDicomSignatureCheck ?? false,
          noDefaultExclusions: eventData.noDefaultExclusions ?? false,
        }

        const controller = new ScanController()
        currentController = controller
        const ctx = { filters, controller, previousIndex, emit }

        let scan: Promise<void>
        if ('path' in eventData) {
          scan = scanDirectoryNode(eventData.path, ctx)
        } else if ('directoryHandle' in eventData) {
          scan = scanDirectory(eventData.directoryHandle, ctx)
        } else if ('bucketOptions' in eventData) {
          scan = scanS3Bucket(eventData.bucketOptions, ctx)
        } else {
          console.error('No valid directory information provided for scanning.')
          break
        }

        // The traversal always emits its own 'done'/'error' before resolving;
        // close the port once it settles so the worker can be reused/torn down.
        scan
          .finally(() => {
            currentController = null
            close()
          })
          // Only reachable if emit itself threw inside a traversal's catch, by
          // which point the scan is over and there is nobody left to tell.
          .catch(() => {})
        break
      }
      case 'stop': {
        // Pause the feeder — the counter is NOT affected by backpressure
        currentController?.pause()
        break
      }
      case 'resume': {
        // Resume the feeder
        currentController?.resume()
        break
      }
      default:
        console.error(
          `Unknown request ${(event.data as { request: string }).request}`,
        )
    }
  }

  return { handleMessage }
}
