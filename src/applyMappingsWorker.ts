import {
  createMappingHandler,
  type MappingEmit,
  type MappingResponse,
} from './applyMappingsCore'
import { fixupNodeWorkerEnvironment } from './worker'

// Re-exported so existing importers keep their paths; defined in
// applyMappingsCore.ts.
export type {
  LookupResponse,
  MappingRequest,
  UploadError,
  UploadResult,
} from './applyMappingsCore'
export { safeSerializeError } from './applyMappingsCore'

// Thread wiring only: message handling lives in applyMappingsCore.ts so it can
// be unit-tested in-process.

// Called with one argument unless there is something to transfer: an explicit
// undefined leaves the outcome to the browser's overload resolution, and no CI
// job exercises the browser path.
//
// Resolved per call, not once at module scope: under Node,
// fixupNodeWorkerEnvironment() defines globalThis.postMessage only after this
// module has been imported.
//
// Cast: in a worker context postMessage accepts a transfer list as the second
// argument, but TypeScript's lib.dom.d.ts types globalThis.postMessage with
// Window's signature which doesn't allow that form.
const emit: MappingEmit = (msg, transfer) => {
  const post = globalThis.postMessage as (
    msg: MappingResponse,
    transfer?: ReadableStream<Uint8Array>[],
  ) => void
  return transfer ? post(msg, transfer) : post(msg)
}

fixupNodeWorkerEnvironment()
  .then(() => {
    const { handleMessage } = createMappingHandler(emit)
    globalThis.addEventListener('message', handleMessage)
  })
  .catch((error) => {
    // Without an environment the worker can never process messages, so
    // dispatched files would vanish until the watchdog notices 10 minutes
    // later. 'initError' tells the pool to drop it and account any file
    // already in flight; the log carries the reason, visible only here.
    const message = `Failed to initialize mapping worker environment: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(message, error)
    const msg: MappingResponse = { response: 'initError', error: message }
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
