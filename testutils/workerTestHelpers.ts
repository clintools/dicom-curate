import { createWorker } from '../src/worker'
import type { FileScanMsg } from '../src/scanDirectoryWorker'

export type FileScanFileMsg = Extract<FileScanMsg, { response: 'file' }>
export type FileScanAnomalyMsg = Extract<
  FileScanMsg,
  { response: 'scanAnomalies' }
>
import type { MappingRequest } from '../src/applyMappingsWorker'
import type { TMapResults } from '../src/types'

const scanWorkerUrl = new URL(
  '../dist/esm/scanDirectoryWorker.js',
  import.meta.url,
)
const mappingWorkerUrl = new URL(
  '../dist/esm/applyMappingsWorker.js',
  import.meta.url,
)

export type ScanCollectResult = {
  files: FileScanFileMsg[]
  anomalies: FileScanAnomalyMsg[]
  counts: number[]
  error?: string
  done: boolean
}

export async function collectScanMessages(
  scanPath: string,
  options?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<ScanCollectResult> {
  const worker = await createWorker(scanWorkerUrl, { type: 'module' })
  const files: FileScanFileMsg[] = []
  const anomalies: FileScanAnomalyMsg[] = []
  const counts: number[] = []
  let error: string | undefined
  let done = false

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate()
      resolve({ files, anomalies, counts, error: 'scan timeout', done })
    }, timeoutMs)

    const onMessage = (event: { data: FileScanMsg }) => {
      const msg = event.data
      switch (msg.response) {
        case 'file':
          files.push(msg)
          break
        case 'scanAnomalies':
          anomalies.push(msg)
          break
        case 'count':
          counts.push(msg.totalDiscovered)
          break
        case 'error':
          error = msg.error
          break
        case 'done':
          done = true
          clearTimeout(timeout)
          worker.terminate()
          resolve({ files, anomalies, counts, error, done })
          break
      }
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', (e: ErrorEvent) => {
      error = String(e.error ?? e.message ?? e)
      clearTimeout(timeout)
      worker.terminate()
      resolve({ files, anomalies, counts, error, done })
    })
    worker.postMessage({ request: 'scan', path: scanPath, ...options })
  })
}

export type MappingWorkerResult =
  | { kind: 'finished'; mapResults: TMapResults }
  | { kind: 'error'; error: string; fileInfo?: MappingRequest['fileInfo'] }
  | { kind: 'lookup'; outputPath: string }
  | { kind: 'timeout' }

export async function runMappingWorker(
  request: MappingRequest,
  options?: {
    onLookup?: (outputPath: string) => { postMappedHash?: string } | undefined
    timeoutMs?: number
  },
): Promise<MappingWorkerResult[]> {
  const worker = await createWorker(mappingWorkerUrl, { type: 'module' })
  const results: MappingWorkerResult[] = []
  const timeoutMs = options?.timeoutMs ?? 30_000

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate()
      results.push({ kind: 'timeout' })
      resolve(results)
    }, timeoutMs)

    worker.addEventListener('message', (event: { data: unknown }) => {
      const msg = event.data as Record<string, unknown>
      if (msg.response === 'lookup') {
        const outputPath = msg.outputPath as string
        results.push({ kind: 'lookup', outputPath })
        const lookupResult = options?.onLookup?.(outputPath)
        worker.postMessage({
          response: 'lookupResult',
          postMappedHash: lookupResult?.postMappedHash,
        })
        return
      }
      if (msg.response === 'finished') {
        results.push({
          kind: 'finished',
          mapResults: msg.mapResults as TMapResults,
        })
        clearTimeout(timeout)
        worker.terminate()
        resolve(results)
        return
      }
      if (msg.response === 'error') {
        results.push({
          kind: 'error',
          error: String(msg.error),
          fileInfo: msg.fileInfo as MappingRequest['fileInfo'],
        })
        clearTimeout(timeout)
        worker.terminate()
        resolve(results)
      }
    })

    worker.addEventListener('error', () => {
      clearTimeout(timeout)
      worker.terminate()
      results.push({ kind: 'error', error: 'worker thread error' })
      resolve(results)
    })

    worker.postMessage(request)
  })
}
