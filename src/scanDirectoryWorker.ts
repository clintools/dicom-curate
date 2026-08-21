import { createScanHandler, type FileScanMsg } from './scanCore'
import { fixupNodeWorkerEnvironment } from './worker'

// Re-exported so existing importers keep their paths; defined in scanCore.ts.
export type { FileScanMsg, FileScanRequest } from './scanCore'
export { isS3KeyExcludedByName } from './scanCore'

// Thread wiring only: scanning logic and message dispatch live in scanCore.ts
// so they can be unit-tested in-process.

function emit(msg: FileScanMsg): void {
  globalThis.postMessage(msg)
}

fixupNodeWorkerEnvironment()
  .then(() => {
    const { handleMessage } = createScanHandler({
      emit,
      close: () => globalThis.close(),
    })
    globalThis.addEventListener('message', handleMessage)
  })
  .catch((error) => {
    // Without this the worker never installs its message listener and the
    // scan request is silently dropped, leaving curateMany waiting forever --
    // and with no listener the thread exits with code 0, which index.ts's
    // exit handler reads as a normal exit. Reported as a scan error so the
    // run is rejected instead.
    const message = `Failed to initialize scan worker environment: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(message, error)
    const msg: FileScanMsg = { response: 'error', error: message }
    try {
      emit(msg)
    } catch {
      // Under Node the rejection happens before fixupNodeWorkerEnvironment()
      // installs globalThis.postMessage, so emit() itself throws. Go direct,
      // matching the { data } wrapping the fixup applies (see worker.ts). If
      // worker_threads was itself the failure, the log above is the last word.
      void import('worker_threads')
        .then(({ parentPort }) => parentPort?.postMessage({ data: msg }))
        .catch(() => {})
    }
  })
