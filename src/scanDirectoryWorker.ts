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

fixupNodeWorkerEnvironment().then(() => {
  const { handleMessage } = createScanHandler({
    emit,
    close: () => globalThis.close(),
  })
  globalThis.addEventListener('message', handleMessage)
})
