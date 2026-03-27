/**
 * Mock scan worker that simulates the count-while-paused backpressure
 * behavior introduced in the scanDirectoryWorker.
 *
 * When emitting files:
 * - In 'feeding' mode: emits { response: 'file' } messages (normal)
 * - After receiving 'stop': switches to 'counting' mode, emits
 *   { response: 'count', totalDiscovered } messages instead, and
 *   buffers file indices for later replay
 * - After receiving 'resume': switches back to 'feeding', drains the
 *   buffer (emitting 'file' for each), optionally rejecting some
 *   (self-correcting the count with updated 'count' messages)
 * - After all files emitted: emits { response: 'done' }
 *
 * Files are read from disk like MockScanWorker, so use with
 * createTestDicomDir fixtures.
 */

import { readdirSync, statSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Module-level configuration — set before calling curateMany so the
// BackpressureScanWorker constructor picks up the options.
// ---------------------------------------------------------------------------

let nextOptions: { rejectOnDrain?: number; emissionDelay?: number } = {}

/**
 * Configure options for the next BackpressureScanWorker instance.
 * Call before curateMany to control scan worker behavior.
 */
export function configureBackpressureScanWorker(options: {
  rejectOnDrain?: number
  emissionDelay?: number
}): void {
  nextOptions = { ...options }
}

/**
 * Reset scan worker configuration. Call in afterEach.
 */
export function resetBackpressureScanWorker(): void {
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

export class BackpressureScanWorker {
  public onerror: ((event: any) => void) | null = null
  public terminated = false

  /**
   * Number of files to reject during the drain phase (after resume).
   * These files were counted during the counting phase but fail the
   * "full filter" during drain, causing a self-correcting count
   * decrement.
   */
  public rejectOnDrain: number

  /**
   * Optional delay (ms) between emissions. Default 0 (as fast as the
   * event loop allows). Set higher to allow abort mid-emission.
   */
  public emissionDelay: number

  private messageListeners: ((event: { data: any }) => void)[] = []
  private state: 'idle' | 'feeding' | 'counting' = 'idle'
  private files: string[] = []
  private scanDir = ''
  /** Index into files[] for the next file to scan (count or feed). */
  private scanIndex = 0
  private totalDiscovered = 0
  /**
   * Indices of files that were counted while paused and need to be
   * replayed (drained) as 'file' messages on resume.
   */
  private drainQueue: number[] = []
  /** Number of files already rejected during drain. */
  private rejectedDuringDrain = 0
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.rejectOnDrain = nextOptions.rejectOnDrain ?? 0
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
            error: 'No path provided to backpressure scan worker',
          })
          return
        }

        this.scanDir = scanDir
        this.files = listFiles(scanDir)
        this.scanIndex = 0
        this.totalDiscovered = 0
        this.drainQueue = []
        this.rejectedDuringDrain = 0
        this.state = 'feeding'
        this.scheduleNext()
        break
      }
      case 'stop': {
        // Main thread is applying backpressure — switch to counting mode
        this.state = 'counting'
        break
      }
      case 'resume': {
        // Main thread released backpressure — drain counted files then
        // continue feeding
        this.state = 'feeding'
        // If we were waiting, kick off emission again
        if (!this.pendingTimeout) {
          this.scheduleNext()
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

  private scheduleNext(): void {
    this.pendingTimeout = setTimeout(() => {
      this.pendingTimeout = null
      this.emitNext()
    }, this.emissionDelay)
  }

  private emitFileAtIndex(fileIndex: number): void {
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

  private emitNext(): void {
    if (this.terminated) return

    if (this.state === 'counting') {
      // Counting mode: advance through files, buffer indices, emit 'count'
      if (this.scanIndex >= this.files.length) {
        // Scanner finished traversing while paused — nothing more to count.
        // We'll emit 'done' once the buffer is drained after resume.
        // Don't schedule another tick — wait for 'resume'.
        return
      }

      this.totalDiscovered++
      this.drainQueue.push(this.scanIndex)
      this.scanIndex++
      this.emit({
        response: 'count',
        totalDiscovered: this.totalDiscovered,
      })
      this.scheduleNext()
      return
    }

    // Feeding mode — drain buffer first, then continue scanning
    if (this.drainQueue.length > 0) {
      const fileIndex = this.drainQueue.shift()!
      const shouldReject = this.rejectedDuringDrain < this.rejectOnDrain

      if (shouldReject) {
        // Self-correct: decrement count and emit corrected count + anomaly
        this.rejectedDuringDrain++
        this.totalDiscovered--
        this.emit({
          response: 'count',
          totalDiscovered: this.totalDiscovered,
        })
        this.emitAnomalyAtIndex(fileIndex)
      } else {
        this.emitFileAtIndex(fileIndex)
      }
      this.scheduleNext()
      return
    }

    // No buffered files — continue scanning new files
    if (this.scanIndex >= this.files.length) {
      // All files scanned and drained — done
      this.emit({ response: 'done' })
      return
    }

    // Normal file emission
    this.totalDiscovered++
    this.emitFileAtIndex(this.scanIndex)
    this.scanIndex++
    this.scheduleNext()
  }

  private emit(data: any): void {
    for (const listener of this.messageListeners) {
      listener({ data })
    }
  }
}
