/**
 * Mock scan worker that reads files from a directory and sends them as
 * TFileInfo messages, mimicking the real scanDirectoryWorker.
 *
 * Files are emitted asynchronously (via setTimeout) to match the real
 * worker's behavior where files trickle in over time.
 */

import { readdirSync, statSync } from 'fs'
import { join } from 'path'

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

export class MockScanWorker {
  public onerror: ((event: any) => void) | null = null
  public terminated = false

  private messageListeners: ((event: { data: any }) => void)[] = []
  private pendingEmitTimeout: ReturnType<typeof setTimeout> | null = null

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
    if (data.request !== 'scan') return

    const scanDir = data.path || data.directoryHandle
    if (!scanDir || typeof scanDir !== 'string') {
      this.emit({
        response: 'error',
        error: 'No path provided to mock scan worker',
      })
      return
    }

    const files = listFiles(scanDir)

    // Emit files asynchronously to match real worker behavior.
    // The real scan worker emits files as it discovers them via worker_threads
    // postMessage, which goes through the event loop. setTimeout(0) simulates this.
    let i = 0
    const emitNext = () => {
      this.pendingEmitTimeout = null
      if (this.terminated) return
      if (i < files.length) {
        const relPath = files[i]
        const parts = relPath.split('/')
        const name = parts.pop()!
        const path = parts.join('/')
        const fullPath = join(scanDir, relPath)
        const stat = statSync(fullPath)

        this.emit({
          response: 'file',
          fileInfo: {
            kind: 'path',
            path: join(scanDir, path),
            name,
            size: stat.size,
          },
        })
        i++
        this.pendingEmitTimeout = setTimeout(emitNext, 0)
      } else {
        this.pendingEmitTimeout = null
        this.emit({ response: 'done' })
      }
    }
    this.pendingEmitTimeout = setTimeout(emitNext, 0)
  }

  terminate(): void {
    this.terminated = true
    if (this.pendingEmitTimeout) {
      clearTimeout(this.pendingEmitTimeout)
      this.pendingEmitTimeout = null
    }
  }

  private emit(data: any): void {
    for (const listener of this.messageListeners) {
      listener({ data })
    }
  }
}
