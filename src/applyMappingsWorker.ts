import { createMappingHandler, type MappingEmit } from './applyMappingsCore'
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

// Cast to any: in a worker context postMessage accepts a transfer list as the
// second argument, but TypeScript's lib.dom.d.ts types globalThis.postMessage
// with Window's signature which doesn't allow that form.
const emit: MappingEmit = (msg, transfer) =>
  (globalThis.postMessage as any)(msg, transfer)

fixupNodeWorkerEnvironment()
  .then(() => {
    const { handleMessage } = createMappingHandler(emit)
    globalThis.addEventListener('message', handleMessage)
  })
  .catch((error) => {
    // If fixupNodeWorkerEnvironment() fails, the worker can never process
    // messages. Log the error so it's visible in the console.
    console.error('Failed to initialize mapping worker environment:', error)
  })
