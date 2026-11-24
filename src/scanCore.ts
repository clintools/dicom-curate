import type { Dirent } from 'fs'
import { delay } from './delay'
import { loadS3Client } from './s3Client'
import type {
  TFileInfo,
  TFileInfoIndex,
  TInputPath,
  TS3BucketOptions,
  TS3Credentials,
  TUnlocatedFileInfo,
} from './types'

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
export function safeReadErrorMessage(
  error: unknown,
  what: 'file' | 'directory' = 'file',
): string {
  let detail = 'unknown error'
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown }
    if (typeof code === 'string' && code) {
      detail = code
    } else if (typeof name === 'string' && name) {
      detail = name
    }
  }
  const action = what === 'directory' ? 'list directory' : 'read file'
  return `Unable to ${action} (filesystem error): ${detail}`
}

/** Waits between attempts to list a directory; its length is the retry count. */
export const LIST_RETRY_DELAYS_MS = [500, 1000, 2000]

/** A directory still could not be listed after every retry. */
class DirectoryListingError extends Error {
  constructor(readonly listError: unknown) {
    super(listError instanceof Error ? listError.message : String(listError))
  }
}

/** Wait out the backoff for a failed listing, or give up once it is spent. */
async function backOffOrThrow(attempt: number, error: unknown): Promise<void> {
  if (attempt >= LIST_RETRY_DELAYS_MS.length) {
    throw new DirectoryListingError(error)
  }
  await delay(LIST_RETRY_DELAYS_MS[attempt])
}

/**
 * Yield a directory's entries, re-listing from the start after a failure and
 * skipping names already yielded, so a mid-listing failure loses nothing.
 */
async function* listEntriesWithRetry(
  dir: FileSystemDirectoryHandle,
): AsyncGenerator<FileSystemHandle> {
  const yielded = new Set<string>()
  let attempt = 0
  for (;;) {
    try {
      for await (const entry of dir.values()) {
        if (yielded.has(entry.name)) continue
        yielded.add(entry.name)
        // Progress earns fresh retries: only a stalled listing exhausts them.
        attempt = 0
        yield entry
      }
      return
    } catch (error) {
      await backOffOrThrow(attempt++, error)
    }
  }
}

/**
 * Retries a child lookup as a listing does, but a missing, wrong-kind or
 * invalidly named child (a TypeError) fails at once so a stale list does not
 * wait out the backoff for each. Throws the lookup's own error: nothing was
 * listed, so it is reported as a read failure.
 */
async function lookUpWithRetry<T extends FileSystemHandle>(
  lookUp: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await lookUp()
    } catch (error) {
      const definitive =
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === 'NotFoundError' ||
            error.name === 'TypeMismatchError'))
      if (definitive || attempt >= LIST_RETRY_DELAYS_MS.length) throw error
      await delay(LIST_RETRY_DELAYS_MS[attempt])
    }
  }
}

async function readdirWithRetry(
  fs: typeof import('fs/promises'),
  dirPath: string,
): Promise<Dirent[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true })
    } catch (error) {
      await backOffOrThrow(attempt, error)
    }
  }
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
      fileInfo: TFileInfo | TUnlocatedFileInfo
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
      /**
       * Set when `fileInfo` names a directory that could not be listed. A
       * `handle` fileInfo then holds a `FileSystemDirectoryHandle`.
       */
      scanTarget?: 'directory'
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
  | {
      // Answered by an 's3Credentials' request.
      response: 's3CredentialsRequest'
    }

type CommonFileScanRequestFields = {
  excludedFiletypes?: string[]
  excludedPathRegexes?: string[]
  fileInfoIndex?: TFileInfoIndex
  inputPaths?: TInputPath[]

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
      // Credentials stay on the main thread: a provider cannot be cloned.
      bucketOptions: Omit<TS3BucketOptions, 'credentials'>
    } & CommonFileScanRequestFields)
  | {
      request: 'stop'
    }
  | {
      request: 'resume'
    }
  | {
      request: 's3Credentials'
      credentials?: TS3Credentials
      error?: string
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
 * Backpressure state for a single scan.
 *
 * When the main thread signals 'stop', the feeder awaits {@link waitIfPaused}
 * before emitting the next file; 'resume' releases it. The counter is NOT
 * affected by backpressure — it always runs at max speed.
 */
export class ScanController {
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

  /** If paused, wait until resumed. */
  async waitIfPaused(): Promise<void> {
    if (this.pausePromise) {
      await this.pausePromise
    }
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
// Per-file feeding, shared by the walks and listed scans so both filter and
// report a file alike. Each returns whether it fed the file; `onRejected`
// runs before any anomaly so the count correction arrives first.
// --------------------------------------------------------------------------

async function feedHandleFile(
  fileHandle: FileSystemFileHandle,
  prefix: string,
  ctx: ScanContext,
  onRejected: () => void,
): Promise<boolean> {
  const { filters, previousIndex, emit } = ctx
  const name = fileHandle.name
  const key = `${prefix}/${name}`
  const prev = previousIndex ? previousIndex[key] : undefined

  let file: File
  try {
    file = await fileHandle.getFile()
  } catch (readError) {
    // An unreadable file must NOT abort the scan. The error omits the name;
    // fileInfo carries it to the private log only.
    onRejected()
    emit({
      response: 'scanAnomalies',
      fileInfo: { path: prefix, name, size: 0, kind: 'handle', fileHandle },
      anomalies: [],
      errors: [safeReadErrorMessage(readError)],
      previousFileInfo: prev,
    } satisfies FileScanMsg)
    return false
  }

  const fileAnomalies: string[] = []
  const fileInfo: TFileInfo = {
    path: prefix,
    name,
    size: file.size,
    kind: 'handle',
    fileHandle,
  }
  if (await shouldProcessFile(file, fileAnomalies, key, filters)) {
    emit({
      response: 'file',
      fileInfo,
      previousFileInfo: prev,
    } satisfies FileScanMsg)
    return true
  }
  onRejected()
  if (fileAnomalies.length > 0) {
    emit({
      response: 'scanAnomalies',
      fileInfo,
      anomalies: fileAnomalies,
      previousFileInfo: prev,
    } satisfies FileScanMsg)
  }
  return false
}

async function feedNodeFile(
  fs: typeof import('fs/promises'),
  fullPath: string,
  name: string,
  prefix: string,
  ctx: ScanContext,
  onRejected: () => void,
): Promise<boolean> {
  const { filters, previousIndex, emit } = ctx
  const key = `${prefix}/${name}`
  const prev = previousIndex ? previousIndex[key] : undefined

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(fullPath)
  } catch (readError) {
    // A file that cannot be stat'd must NOT abort the scan. The error omits
    // the path; fileInfo carries it to the private log only.
    onRejected()
    emit({
      response: 'scanAnomalies',
      fileInfo: { path: prefix, name, size: 0, kind: 'path', fullPath },
      anomalies: [],
      errors: [safeReadErrorMessage(readError)],
      previousFileInfo: prev,
    } satisfies FileScanMsg)
    return false
  }

  const fileInfo: TFileInfo = {
    path: prefix,
    name,
    size: stats.size,
    kind: 'path',
    fullPath,
  }
  // A listed path can name a directory or FIFO, which the signature read
  // would pass or block on.
  if (!stats.isFile()) {
    onRejected()
    emit({
      response: 'scanAnomalies',
      fileInfo,
      anomalies: [],
      errors: [NOT_A_FILE_ERROR],
      previousFileInfo: prev,
    } satisfies FileScanMsg)
    return false
  }

  const fileAnomalies: string[] = []
  if (
    await shouldProcessFileNode(
      fullPath,
      name,
      stats.size,
      fileAnomalies,
      key,
      filters,
    )
  ) {
    emit({
      response: 'file',
      fileInfo,
      previousFileInfo: prev,
    } satisfies FileScanMsg)
    return true
  }
  onRejected()
  if (fileAnomalies.length > 0) {
    emit({
      response: 'scanAnomalies',
      fileInfo,
      anomalies: fileAnomalies,
      previousFileInfo: prev,
    } satisfies FileScanMsg)
  }
  return false
}

async function feedS3Item(
  item: { Key?: string; Size?: number },
  ctx: ScanContext,
  onRejected: () => void,
): Promise<boolean> {
  const { filters, controller, previousIndex, emit } = ctx
  const { Key: key, Size: size } = item
  if (!key || size === undefined) {
    onRejected()
    return false
  }
  const fileAnomalies: string[] = []
  const fileInfo: TFileInfo = {
    size,
    name: key,
    path: key,
    objectKey: key,
    kind: 's3',
  }
  const previousFileInfo = previousIndex ? previousIndex[key] : undefined
  if (await shouldProcessFileItem(item, fileAnomalies, filters)) {
    // Before the emit, so a paused scan holds the file back. A full listing
    // never yields mid-page, so there 'stop' takes effect from the next page.
    await controller.waitIfPaused()
    emit({ response: 'file', fileInfo, previousFileInfo } satisfies FileScanMsg)
    return true
  }
  onRejected()
  if (fileAnomalies.length > 0) {
    emit({
      response: 'scanAnomalies',
      fileInfo,
      anomalies: fileAnomalies,
      previousFileInfo,
    } satisfies FileScanMsg)
  }
  return false
}

function createS3Client(
  s3: Awaited<ReturnType<typeof loadS3Client>>,
  bucketOptions: Omit<TS3BucketOptions, 'credentials'>,
  credentials: TS3Credentials | undefined,
) {
  return new s3.S3Client({
    region: bucketOptions.region,
    credentials,
    endpoint: bucketOptions.endpoint,
    forcePathStyle: bucketOptions.forcePathStyle,
  })
}

// --------------------------------------------------------------------------
// Listed scans: only the files named in `inputPaths`, with no traversal
// --------------------------------------------------------------------------

/** Error reported for a listed entry that names no file under the scan root. */
export const UNLOCATED_INPUT_ERROR =
  'Unable to read file: the listed path is not under the scan root'

/** Error reported for a listed key the bucket does not hold. */
export const MISSING_KEY_ERROR =
  'Unable to read file: the listed key is not in the bucket'

/** Error reported for a path that names something other than a file. */
export const NOT_A_FILE_ERROR =
  'Unable to read file: the path is not a regular file'

type FeedOne = (entry: TInputPath, onRejected: () => void) => Promise<void>

/**
 * `makeFeed` runs inside the try so a setup failure reaches the main thread as
 * an error.
 */
async function scanListed(
  inputPaths: readonly TInputPath[],
  ctx: ScanContext,
  label: string,
  makeFeed: () => FeedOne | Promise<FeedOne>,
): Promise<void> {
  const { controller, emit } = ctx
  let totalDiscovered = 0
  const emitCount = () =>
    emit({ response: 'count', totalDiscovered } satisfies FileScanMsg)
  try {
    // Inside the try so a malformed list still fails the run. Keyed on both
    // fields so no file is mapped twice and {a, b/c} cannot displace {a/b, c}.
    const entries = [
      ...new Map(
        inputPaths.map((e) => [JSON.stringify([e.path, e.name]), e]),
      ).values(),
    ]
    totalDiscovered = entries.length
    // An empty list would map nothing and report success.
    if (entries.length === 0) throw new Error('inputPaths is empty')
    // Before makeFeed, whose root check can list a large directory.
    emitCount()
    const feedOne = await makeFeed()
    for (const entry of entries) {
      await feedOne(entry, () => {
        totalDiscovered--
        emitCount()
      })
      await controller.waitIfPaused()
    }
    emit({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    emit({
      response: 'error',
      error: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  }
}

/** The count goes first so the main thread's total never trails the error. */
function emitUnlocated(
  entry: TInputPath,
  ctx: ScanContext,
  onRejected: () => void,
  error = UNLOCATED_INPUT_ERROR,
): void {
  onRejected()
  ctx.emit({
    response: 'scanAnomalies',
    fileInfo: {
      path: entry.path,
      name: entry.name,
      size: 0,
      kind: 'unlocated',
    },
    anomalies: [],
    errors: [error],
  } satisfies FileScanMsg)
}

/**
 * Undefined when the path does not start at the root's name, as every walked
 * path does, or would climb out of it.
 */
function segmentsBelowRoot(
  entry: TInputPath,
  rootName: string,
): string[] | undefined {
  const [root, ...rest] = entry.path.split('/')
  const unsafe = (segment: string) =>
    segment === '' || segment === '.' || segment === '..'
  if (root !== rootName || rest.some(unsafe)) return undefined
  if (unsafe(entry.name) || entry.name.includes('/')) return undefined
  return rest
}

/**
 * A case-insensitive volume resolves a miscased entry, so each component must
 * match a name its directory's listing reports. Listings are cached by path,
 * a rejection included: every file under a failed directory fails alike.
 */
function spellingCheck(list: (segments: string[]) => Promise<string[]>) {
  const names = new Map<string, Promise<Set<string>>>()
  const namesIn = (segments: string[]): Promise<Set<string>> => {
    const key = segments.join('/')
    let found = names.get(key)
    if (!found) {
      found = list(segments).then((listed) => new Set(listed))
      names.set(key, found)
    }
    return found
  }
  const spelledAsWalked = async (segments: string[], name: string) => {
    const components = [...segments, name]
    for (const [i, component] of components.entries()) {
      if (!(await namesIn(segments.slice(0, i))).has(component)) return false
    }
    return true
  }
  return { namesIn, spelledAsWalked }
}

/** A listing failure is reported as one; anything else as a read failure. */
function lookupErrorMessage(error: unknown): string {
  return error instanceof DirectoryListingError
    ? safeReadErrorMessage(error.listError, 'directory')
    : safeReadErrorMessage(error)
}

export async function scanListedHandles(
  dir: FileSystemDirectoryHandle,
  inputPaths: readonly TInputPath[],
  ctx: ScanContext,
): Promise<void> {
  // A rejection is cached too: every file under a failed directory fails
  // alike, as in a walk.
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>()
  const dirAt = (segments: string[]): Promise<FileSystemDirectoryHandle> => {
    if (segments.length === 0) return Promise.resolve(dir)
    const key = segments.join('/')
    let found = dirs.get(key)
    if (!found) {
      found = dirAt(segments.slice(0, -1)).then((parent) =>
        lookUpWithRetry(() =>
          parent.getDirectoryHandle(segments[segments.length - 1]),
        ),
      )
      dirs.set(key, found)
    }
    return found
  }
  const { namesIn, spelledAsWalked } = spellingCheck(async (segments) => {
    const listed: string[] = []
    for await (const child of listEntriesWithRetry(await dirAt(segments))) {
      listed.push(child.name)
    }
    return listed
  })

  await scanListed(inputPaths, ctx, 'Directory scan', async () => {
    // A root that cannot be listed fails the run, as in a walk.
    await namesIn([])
    return async (entry, onRejected) => {
      const segments = segmentsBelowRoot(entry, dir.name)
      if (!segments) return emitUnlocated(entry, ctx, onRejected)
      let fileHandle: FileSystemFileHandle
      let spelled: boolean
      try {
        const parent = await dirAt(segments)
        fileHandle = await lookUpWithRetry(() =>
          parent.getFileHandle(entry.name),
        )
        spelled = await spelledAsWalked(segments, entry.name)
      } catch (error) {
        return emitUnlocated(entry, ctx, onRejected, lookupErrorMessage(error))
      }
      if (!spelled) return emitUnlocated(entry, ctx, onRejected)
      await feedHandleFile(fileHandle, entry.path, ctx, onRejected)
    }
  })
}

/**
 * Undefined when a component is not a plain name for `path` (a backslash or
 * drive prefix on Windows), which a walk never reports.
 */
export function relativeNodePath(
  segments: readonly string[],
  name: string,
  path: typeof import('path'),
): string | undefined {
  const components = [...segments, name]
  if (components.some((c) => path.basename(c) !== c)) return undefined
  return path.join(...components)
}

export async function scanListedNodePaths(
  dirPath: string,
  inputPaths: readonly TInputPath[],
  ctx: ScanContext,
): Promise<void> {
  await scanListed(inputPaths, ctx, 'Directory scan', async () => {
    const fs = await import('fs/promises')
    const path = await import('path')
    const rootName = path.basename(dirPath)
    const realRoot = await fs.realpath(dirPath)
    const { namesIn, spelledAsWalked } = spellingCheck(async (segments) =>
      (await readdirWithRetry(fs, path.join(dirPath, ...segments))).map(
        (d) => d.name,
      ),
    )
    // A root that cannot be listed fails the run, as in a walk.
    await namesIn([])
    return async (entry, onRejected) => {
      const segments = segmentsBelowRoot(entry, rootName)
      const relative = segments && relativeNodePath(segments, entry.name, path)
      if (!segments || !relative) return emitUnlocated(entry, ctx, onRejected)
      const fullPath = path.join(dirPath, relative)
      // A walk does not follow symlinks.
      const resolved = await fs.realpath(fullPath).then(
        (real) => real === path.join(realRoot, relative),
        // Left to feedNodeFile, which reports why it cannot be read.
        () => undefined,
      )
      if (resolved === false) return emitUnlocated(entry, ctx, onRejected)
      if (resolved) {
        // realpath keeps the listed case on Linux, even on a case-insensitive
        // mount.
        let spelled: boolean
        try {
          spelled = await spelledAsWalked(segments, entry.name)
        } catch (error) {
          return emitUnlocated(
            entry,
            ctx,
            onRejected,
            lookupErrorMessage(error),
          )
        }
        if (!spelled) return emitUnlocated(entry, ctx, onRejected)
      }
      await feedNodeFile(fs, fullPath, entry.name, entry.path, ctx, onRejected)
    }
  })
}

export async function scanListedS3Keys(
  bucketOptions: Omit<TS3BucketOptions, 'credentials'>,
  inputPaths: readonly TInputPath[],
  ctx: ScanContext,
  requestCredentials: () => Promise<TS3Credentials | undefined>,
): Promise<void> {
  await scanListed(inputPaths, ctx, 'S3 bucket scan', async () => {
    const s3 = await loadS3Client()
    // ListObjectsV2, as the full scan sends, rather than HeadObject, which a
    // bucket's CORS rule may not allow. A client per request, as there.
    const firstUnder = async (prefix: string | undefined) => {
      const client = createS3Client(
        s3,
        bucketOptions,
        await requestCredentials(),
      )
      return client
        .send(
          new s3.ListObjectsV2Command({
            Bucket: bucketOptions.bucketName,
            Prefix: prefix,
            MaxKeys: 1,
          }),
        )
        .finally(() => client.destroy())
    }
    // A bucket that cannot be listed fails the run, as in a full scan.
    await firstUnder(bucketOptions.prefix)
    return async (entry, onRejected) => {
      // A listing reports the key as both path and name, under the prefix.
      const key = entry.name
      if (entry.path !== key || !key.startsWith(bucketOptions.prefix ?? '')) {
        return emitUnlocated(entry, ctx, onRejected)
      }
      let item: { Key?: string; Size?: number } | undefined
      try {
        // A key sorts first among the keys it prefixes. Needs a general-purpose
        // bucket: a directory bucket lists unsorted and takes only `/` prefixes.
        item = (await firstUnder(key)).Contents?.[0]
      } catch (error) {
        return emitUnlocated(
          entry,
          ctx,
          onRejected,
          safeReadErrorMessage(error),
        )
      }
      if (item?.Key !== key || item.Size === undefined) {
        return emitUnlocated(entry, ctx, onRejected, MISSING_KEY_ERROR)
      }
      await feedS3Item(item, ctx, onRejected)
    }
  })
}

// --------------------------------------------------------------------------
// S3 path: bucket listing
// --------------------------------------------------------------------------

export async function scanS3Bucket(
  bucketOptions: Omit<TS3BucketOptions, 'credentials'>,
  ctx: ScanContext,
  // Resolves to undefined when the run has no credentials: the SDK default
  // chain applies.
  requestCredentials: () => Promise<TS3Credentials | undefined>,
): Promise<void> {
  const { emit } = ctx
  let totalDiscovered = 0
  try {
    const s3 = await loadS3Client()

    // Page through the S3 bucket listing using ContinuationToken
    let continuationToken: string | undefined

    do {
      // A client per page, with credentials fetched for it: the SDK keeps
      // credentials that carry no expiration for the client's whole life.
      const client = createS3Client(
        s3,
        bucketOptions,
        await requestCredentials(),
      )

      const listCommand = new s3.ListObjectsV2Command({
        Bucket: bucketOptions.bucketName,
        Prefix: bucketOptions.prefix,
        ContinuationToken: continuationToken,
      })

      // Destroyed per page, or each page's keep-alive sockets outlive it.
      const data = await client
        .send(listCommand)
        .finally(() => client.destroy())

      if (data.Contents) {
        for (const item of data.Contents) {
          // The count only ever rises here, so a rejection needs no correction.
          if (await feedS3Item(item, ctx, () => {})) {
            totalDiscovered++
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
  const { filters, controller, emit } = ctx
  // Shared by the counter and feeder below, which run interleaved via
  // Promise.all. Access is safe because both run in the same worker and JS is
  // single-threaded; the counter increments, the feeder decrements on files
  // that fail the full filter.
  let totalDiscovered = 0
  // Files the feeder has emitted: the exact total, and the floor for the
  // reported total once the counter has skipped a directory.
  let filesFed = 0
  let countIncomplete = false
  const emitCount = () =>
    emit({
      response: 'count',
      totalDiscovered: countIncomplete
        ? Math.max(totalDiscovered, filesFed)
        : totalDiscovered,
    } satisfies FileScanMsg)

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
    for await (const entry of listEntriesWithRetry(dirHandle)) {
      if (entry.kind === 'file') {
        const key = `${prefix}/${entry.name}`

        if (cheapFilterNameOnly(entry.name, key, filters)) {
          totalDiscovered++
          emitCount()
        }
      } else if (entry.kind === 'directory') {
        try {
          await counter(
            entry as FileSystemDirectoryHandle,
            prefix + '/' + entry.name,
          )
        } catch (error) {
          if (!(error instanceof DirectoryListingError)) throw error
          // The feeder reports it. Carry on, so one bad directory does not
          // leave the rest of the tree uncounted.
          countIncomplete = true
        }
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
    for await (const entry of listEntriesWithRetry(dirHandle)) {
      if (entry.kind === 'file') {
        const fed = await feedHandleFile(
          entry as FileSystemFileHandle,
          prefix,
          ctx,
          () => {
            // If it would have passed the counter's name-only filter, the
            // counter already counted it — correct.
            if (
              cheapFilterNameOnly(
                entry.name,
                `${prefix}/${entry.name}`,
                filters,
              )
            ) {
              totalDiscovered--
              emitCount()
            }
          },
        )
        if (fed) {
          filesFed++
          if (countIncomplete) emitCount()
        }

        // Backpressure: may pause the feeder for memory control
        await controller.waitIfPaused()
      } else if (entry.kind === 'directory') {
        try {
          await feeder(
            entry as FileSystemDirectoryHandle,
            prefix + '/' + entry.name,
          )
        } catch (error) {
          if (!(error instanceof DirectoryListingError)) throw error
          // A sub-directory that cannot be listed must NOT abort the scan.
          // Report it and carry on with its siblings.
          emit({
            response: 'scanAnomalies',
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: 0,
              kind: 'handle',
              fileHandle: entry as unknown as FileSystemFileHandle,
            },
            anomalies: [],
            errors: [safeReadErrorMessage(error.listError, 'directory')],
            scanTarget: 'directory',
          } satisfies FileScanMsg)
        }
      }
    }
  }

  try {
    // Run counter and feeder concurrently. The counter finishes first
    // (~8x faster), giving an accurate total. The feeder runs for the
    // duration of processing, subject to backpressure.
    await Promise.all([
      // The count is only an estimate: its failure must not end a scan whose
      // feeder is healthy.
      counter(dir, dir.name).catch(() => {
        countIncomplete = true
        emitCount()
      }),
      feeder(dir, dir.name),
    ])

    // Final count sync: exact even when the counter failed or the feeder
    // skipped a directory the counter had counted.
    emit({
      response: 'count',
      totalDiscovered: filesFed,
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
  const { filters, controller, emit } = ctx
  // Shared by the counter and feeder below, which run interleaved via
  // Promise.all. Access is safe because both run in the same worker and JS is
  // single-threaded; the counter increments, the feeder decrements on files
  // that fail the full filter.
  let totalDiscovered = 0
  // Files the feeder has emitted: the exact total, and the floor for the
  // reported total once the counter has skipped a directory.
  let filesFed = 0
  let countIncomplete = false
  const emitCount = () =>
    emit({
      response: 'count',
      totalDiscovered: countIncomplete
        ? Math.max(totalDiscovered, filesFed)
        : totalDiscovered,
    } satisfies FileScanMsg)

  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    /**
     * Counter: traverses using readdir + name filter only.
     * No stat() calls — just checks file name against exclusion lists.
     * Emits 'count' at max speed.
     */
    async function counter(currentPath: string, prefix: string): Promise<void> {
      const entries = await readdirWithRetry(fs, currentPath)
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (entry.isFile()) {
          const key = `${prefix}/${entry.name}`

          if (cheapFilterNameOnly(entry.name, key, filters)) {
            totalDiscovered++
            emitCount()
          }
        } else if (entry.isDirectory()) {
          try {
            await counter(
              path.join(currentPath, entry.name),
              prefix + '/' + entry.name,
            )
          } catch (error) {
            if (!(error instanceof DirectoryListingError)) throw error
            // The feeder reports it. Carry on, so one bad directory does not
            // leave the rest of the tree uncounted.
            countIncomplete = true
          }
        }
      }
    }

    /**
     * Feeder: traverses with full filter (DICOM signature check).
     * Emits 'file' messages. Subject to backpressure. Corrects the
     * counter's estimate when files fail the full filter.
     */
    async function feeder(currentPath: string, prefix: string): Promise<void> {
      const entries = await readdirWithRetry(fs, currentPath)
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (entry.isFile()) {
          const fed = await feedNodeFile(
            fs,
            path.join(currentPath, entry.name),
            entry.name,
            prefix,
            ctx,
            () => {
              // Correct the counter's estimate if needed
              if (
                cheapFilterNameOnly(
                  entry.name,
                  `${prefix}/${entry.name}`,
                  filters,
                )
              ) {
                totalDiscovered--
                emitCount()
              }
            },
          )
          if (fed) {
            filesFed++
            if (countIncomplete) emitCount()
          }

          // Backpressure: may pause the feeder for memory control
          await controller.waitIfPaused()
        } else if (entry.isDirectory()) {
          const dirFullPath = path.join(currentPath, entry.name)
          try {
            await feeder(dirFullPath, prefix + '/' + entry.name)
          } catch (error) {
            if (!(error instanceof DirectoryListingError)) throw error
            // A sub-directory that cannot be listed must NOT abort the scan.
            // Report it and carry on with its siblings.
            emit({
              response: 'scanAnomalies',
              fileInfo: {
                path: prefix,
                name: entry.name,
                size: 0,
                kind: 'path',
                fullPath: dirFullPath,
              },
              anomalies: [],
              errors: [safeReadErrorMessage(error.listError, 'directory')],
              scanTarget: 'directory',
            } satisfies FileScanMsg)
          }
        }
      }
    }

    const dirName = path.basename(dirPath)

    // Run counter and feeder concurrently
    await Promise.all([
      // The count is only an estimate: its failure must not end a scan whose
      // feeder is healthy.
      counter(dirPath, dirName).catch(() => {
        countIncomplete = true
        emitCount()
      }),
      feeder(dirPath, dirName),
    ])

    // Final count sync: exact even when the counter failed or the feeder
    // skipped a directory the counter had counted.
    emit({
      response: 'count',
      totalDiscovered: filesFed,
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

  // Listing is sequential, so at most one credentials request is outstanding.
  let pendingCredentials:
    | {
        resolve: (credentials: TS3Credentials | undefined) => void
        reject: (error: Error) => void
      }
    | undefined

  function requestS3Credentials(): Promise<TS3Credentials | undefined> {
    return new Promise((resolve, reject) => {
      pendingCredentials = { resolve, reject }
      emit({ response: 's3CredentialsRequest' })
    })
  }

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

        const { inputPaths } = eventData
        let scan: Promise<void>
        if ('path' in eventData) {
          scan = inputPaths
            ? scanListedNodePaths(eventData.path, inputPaths, ctx)
            : scanDirectoryNode(eventData.path, ctx)
        } else if ('directoryHandle' in eventData) {
          scan = inputPaths
            ? scanListedHandles(eventData.directoryHandle, inputPaths, ctx)
            : scanDirectory(eventData.directoryHandle, ctx)
        } else if ('bucketOptions' in eventData) {
          scan = inputPaths
            ? scanListedS3Keys(
                eventData.bucketOptions,
                inputPaths,
                ctx,
                requestS3Credentials,
              )
            : scanS3Bucket(eventData.bucketOptions, ctx, requestS3Credentials)
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
      case 's3Credentials': {
        const pending = pendingCredentials
        pendingCredentials = undefined
        if (event.data.error !== undefined) {
          pending?.reject(new Error(event.data.error))
        } else {
          pending?.resolve(event.data.credentials)
        }
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
