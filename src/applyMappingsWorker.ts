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
    // If fixupNodeWorkerEnvironment() fails, the worker can never process
    // messages: dispatched files vanish silently until the stall watchdog
    // notices up to 10 minutes later. Log here (worker-thread console, the
    // only place the detailed reason is visible) and tell the pool: a
    // response tag outside the normal union routes through its default:
    // branch, which terminates and replaces the worker and accounts any
    // in-flight file. Only effective if a file was already dispatched:
    // recoverCrashedWorker bails for an idle worker (a pre-existing gap),
    // leaving the watchdog as the only cover.
    const message = `Failed to initialize mapping worker environment: ${
      error instanceof Error ? error.message : String(error)
    }`
    console.error(message, error)
    try {
      emit({
        response: 'initError',
        error: message,
      } as unknown as MappingResponse)
    } catch {
      // postMessage unavailable -- already logged above.
    }
  })
