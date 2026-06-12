/**
 * Mock scan worker that simulates the parallel counter+feeder architecture.
 *
 * Behavior:
 * - On 'scan': reads files from disk, then runs two "goroutines":
 *   1. Counter: emits all 'count' messages immediately (one per file,
 *      cheap filter only). This simulates the fast counter that finishes
 *      well before the feeder.
 *   2. Feeder: emits 'file' messages one at a time via setTimeout,
 *      respecting 'stop'/'resume' backpressure. Optionally rejects some
 *      files (simulating full-filter failures), emitting corrected 'count'.
 * - After both finish: emits final 'count' + 'done'.
 *
 * This replaces the old BackpressureScanWorker which simulated the
 * counting-mode state machine (now removed from the real scan worker).
 */

import { readdirSync, statSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Module-level configuration
// ---------------------------------------------------------------------------

let nextOptions: {
  rejectCount?: number
  emissionDelay?: number
  readErrorCount?: number
} = {}

/**
 * Configure options for the next ParallelScanWorker instance.
 * @param options.rejectCount Number of files the feeder will reject (correcting the count).
 * @param options.emissionDelay Delay in ms between feeder file emissions (default 0).
 * @param options.readErrorCount Number of files that fail to read (emit scanAnomalies with `errors`).
 */
export function configureParallelScanWorker(options: {
  rejectCount?: number
  emissionDelay?: number
  readErrorCount?: number
}): void {
  nextOptions = { ...options }
}

export function resetParallelScanWorker(): void {
  nextOptions = {}
}

function listFiles(dir: string, base: string = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), rel))
    } else {
      files.push(rel)
    }
  }
  return files
}

export class ParallelScanWorker {
  public onerror: ((event: any) => void) | null = null
  public terminated = false

  /** Number of files the feeder will reject (simulating full-filter failures). */
  public rejectCount: number

  /** Number of files the feeder will fail to read (read-error scanAnomalies). */
  public readErrorCount: number

  /** Delay between feeder emissions (ms). */
  public emissionDelay: number

  private messageListeners: ((event: { data: any }) => void)[] = []
  private files: string[] = []
  private scanDir = ''
  private totalDiscovered = 0
  private feederIndex = 0
  private rejectedSoFar = 0
  private readErrorsSoFar = 0
  private paused = false
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.rejectCount = nextOptions.rejectCount ?? 0
    this.readErrorCount = nextOptions.readErrorCount ?? 0
    this.emissionDelay = nextOptions.emissionDelay ?? 0
  }

  addEventListener(event: string, listener: any): void {
    if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  on(event: string, listener: any): void {
    if (event === 'message') {
      this.messageListeners.push(listener)
    }
  }

  postMessage(data: any): void {
    if (this.terminated) return

    switch (data.request) {
      case 'scan': {
        const scanDir = data.path || data.directoryHandle
        if (!scanDir || typeof scanDir !== 'string') {
          this.emit({
            response: 'error',
            error: 'No path provided to parallel scan worker',
          })
          return
        }

        this.scanDir = scanDir
        this.files = listFiles(scanDir)
        this.totalDiscovered = 0
        this.feederIndex = 0
        this.rejectedSoFar = 0
        this.readErrorsSoFar = 0
        this.paused = false

        // Counter: emit all 'count' messages immediately (synchronous).
        // This simulates the fast counter finishing well before the feeder.
        for (let i = 0; i < this.files.length; i++) {
          this.totalDiscovered++
          this.emit({
            response: 'count',
            totalDiscovered: this.totalDiscovered,
          })
        }

        // Feeder: start emitting 'file' messages asynchronously
        this.scheduleNextFeed()
        break
      }
      case 'stop': {
        this.paused = true
        break
      }
      case 'resume': {
        this.paused = false
        if (!this.pendingTimeout) {
          this.scheduleNextFeed()
        }
        break
      }
    }
  }

  terminate(): void {
    this.terminated = true
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout)
      this.pendingTimeout = null
    }
  }

  private scheduleNextFeed(): void {
    if (this.terminated) return
    this.pendingTimeout = setTimeout(() => {
      this.pendingTimeout = null
      if (this.terminated) return
      this.feedNext()
    }, this.emissionDelay)
  }

  private feedNext(): void {
    if (this.terminated) return

    // If paused, wait for resume
    if (this.paused) return

    if (this.feederIndex >= this.files.length) {
      // All files fed — emit final count sync + done
      this.emit({
        response: 'count',
        totalDiscovered: this.totalDiscovered,
      })
      this.emit({ response: 'done' })
      return
    }

    const fileIndex = this.feederIndex
    this.feederIndex++

    // Should this file fail to read entirely (read-error)?
    const shouldReadError = this.readErrorsSoFar < this.readErrorCount
    // Should this file be rejected by the full filter?
    const shouldReject =
      !shouldReadError && this.rejectedSoFar < this.rejectCount
    if (shouldReadError) {
      this.readErrorsSoFar++
      this.totalDiscovered--
      this.emit({
        response: 'count',
        totalDiscovered: this.totalDiscovered,
      })
      this.emitReadErrorAtIndex(fileIndex)
    } else if (shouldReject) {
      this.rejectedSoFar++
      this.totalDiscovered--
      this.emit({
        response: 'count',
        totalDiscovered: this.totalDiscovered,
      })
      this.emitAnomalyAtIndex(fileIndex)
    } else {
      this.emitFileAtIndex(fileIndex)
    }

    if (this.terminated) return
    this.scheduleNextFeed()
  }

  private emitFileAtIndex(fileIndex: number): void {
    if (this.terminated) return

    const relPath = this.files[fileIndex]
    const parts = relPath.split('/')
    const name = parts.pop()!
    const path = parts.join('/')
    const fullPath = join(this.scanDir, relPath)
    const stat = statSync(fullPath)

    this.emit({
      response: 'file',
      fileInfo: {
        kind: 'path',
        path: join(this.scanDir, path),
        name,
        size: stat.size,
      },
    })
  }

  private emitAnomalyAtIndex(fileIndex: number): void {
    if (this.terminated) return

    const relPath = this.files[fileIndex]
    const parts = relPath.split('/')
    const name = parts.pop()!
    const path = parts.join('/')
    const fullPath = join(this.scanDir, relPath)
    const stat = statSync(fullPath)

    this.emit({
      response: 'scanAnomalies',
      fileInfo: {
        kind: 'path',
        path: join(this.scanDir, path),
        name,
        size: stat.size,
      },
      anomalies: ['Skipped file without DICOM signature: ' + name],
    })
  }

  private emitReadErrorAtIndex(fileIndex: number): void {
    if (this.terminated) return

    const relPath = this.files[fileIndex]
    const parts = relPath.split('/')
    const name = parts.pop()!
    const path = parts.join('/')

    // Read-error: the file could not be read at all, so size is unknown (0)
    // and we surface a PHI-safe error string (no filename). The real worker
    // does the same.
    this.emit({
      response: 'scanAnomalies',
      fileInfo: {
        kind: 'path',
        path: join(this.scanDir, path),
        name,
        size: 0,
      },
      anomalies: [],
      errors: ['Unable to read file (filesystem error): EACCES'],
    })
  }

  private emit(data: any): void {
    for (const listener of this.messageListeners) {
      listener({ data })
    }
  }
}
