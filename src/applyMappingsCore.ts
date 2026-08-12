import { curateOne } from './curateOne'
import { deserializeMappingOptions } from './serializeMappingOptions'
import type {
  TFileInfo,
  THashMethod,
  TOutputTarget,
  TSerializedMappingOptions,
} from './types'

/**
 * Thread-agnostic message handling. Kept out of applyMappingsWorker.ts so it can
 * be unit-tested in-process — Vitest's v8 provider cannot attribute coverage to
 * code running inside a worker_threads child.
 */

export type MappingRequest = {
  request: 'apply'
  fileInfo: TFileInfo
  outputTarget?: TOutputTarget
  previousFileInfo?: {
    size?: number
    mtime?: string
    preMappedHash?: string
  }
  hashMethod?: THashMethod
  hashPartSize?: number
  serializedMappingOptions: TSerializedMappingOptions
}

/** Response sent back from the main thread for a fileInfoIndex lookup. */
export type LookupResponse = {
  response: 'lookupResult'
  postMappedHash?: string
}

/** Response sent from the main thread when a custom upload succeeds. */
export type UploadResult = {
  response: 'uploadResult'
  etag?: string
}

/** Response sent from the main thread when a custom upload fails. */
export type UploadError = {
  response: 'uploadError'
  error: string
}

/** Mapping results as curateOne returns them, forwarded verbatim. */
type MapResults = Awaited<ReturnType<typeof curateOne>>

/** Everything the mapping worker sends back to the main thread. */
export type MappingResponse =
  | { response: 'error'; error: string; fileInfo: TFileInfo }
  | { response: 'lookup'; outputPath: string }
  | {
      response: 'upload'
      key: string
      stream: ReadableStream<Uint8Array>
      size: number
      contentType?: string
      headers?: Record<string, string>
    }
  | { response: 'finished'; mapResults: MapResults }

/**
 * Callback used to emit results to the main thread. The optional transfer list
 * matches the worker postMessage form used to hand off a ReadableStream — the
 * upload stream is the only thing this worker ever transfers.
 */
export type MappingEmit = (
  msg: MappingResponse,
  transfer?: ReadableStream<Uint8Array>[],
) => void

/**
 * Safely serialize an error for postMessage to avoid DataCloneError.
 * Some error objects contain non-cloneable properties (circular references,
 * native handles, etc.) that cause postMessage to throw.
 */
export function safeSerializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  try {
    return String(error)
  } catch {
    return 'Unknown error (could not serialize)'
  }
}

/**
 * Build the message handler for a mapping worker. All results are sent through
 * `emit`; the per-worker lookup/upload round-trip state is captured in the
 * closure. Safe as singletons because the pool dispatches at most one file per
 * worker at a time, so only one lookup and one upload are ever in flight.
 */
export function createMappingHandler(emit: MappingEmit) {
  /**
   * Send an error response back to the main thread. Uses safeSerializeError
   * to prevent DataCloneError from causing the worker to die silently.
   */
  function postErrorResponse(error: unknown, fileInfo: TFileInfo): void {
    try {
      emit({
        response: 'error',
        error: safeSerializeError(error),
        fileInfo,
      })
    } catch {
      // Last resort: if even the safe serialization fails, send a minimal response
      // so the main thread can recover the worker slot.
      emit({
        response: 'error',
        error: 'Worker error (failed to serialize)',
        fileInfo: {
          name: fileInfo?.name ?? 'unknown',
          path: fileInfo?.path ?? 'unknown',
          kind: fileInfo?.kind ?? 'unknown',
        } as TFileInfo,
      })
    }
  }

  /**
   * Pending lookup resolve function. At most one lookup is in flight at a time
   * because each worker processes one file at a time sequentially.
   */
  let pendingLookupResolve:
    | ((result: { postMappedHash?: string } | undefined) => void)
    | null = null

  /**
   * Request a postMappedHash lookup from the main thread.
   * Returns a Promise that resolves when the main thread replies with
   * a 'lookupResult' message.
   */
  function lookupMappedFileInfo(
    outputPath: string,
  ): Promise<{ postMappedHash?: string } | undefined> {
    return new Promise((resolve) => {
      pendingLookupResolve = resolve
      emit({
        response: 'lookup',
        outputPath,
      })
    })
  }

  // Pending resolve/reject for an in-flight custom upload round-trip.
  let pendingUploadResolve: ((r: { etag?: string }) => void) | null = null
  let pendingUploadReject: ((e: unknown) => void) | null = null

  /**
   * Proxy a custom upload through the main thread. Transfers the ReadableStream
   * directly (zero-copy, no materialisation) so the main thread can hand it
   * as-is to the user-supplied TCustomUploader.
   */
  function uploadViaMain(args: {
    key: string
    stream: ReadableStream<Uint8Array>
    size: number
    contentType?: string
    headers?: Record<string, string>
  }): Promise<{ etag?: string }> {
    return new Promise((resolve, reject) => {
      pendingUploadResolve = resolve
      pendingUploadReject = reject
      emit(
        {
          response: 'upload',
          key: args.key,
          stream: args.stream,
          size: args.size,
          contentType: args.contentType,
          headers: args.headers,
        },
        [args.stream],
      )
    })
  }

  function handleMessage(
    event: MessageEvent<
      MappingRequest | LookupResponse | UploadResult | UploadError
    >,
  ): void {
    // Handle lookup response from main thread
    if ('response' in event.data && event.data.response === 'lookupResult') {
      const resolve = pendingLookupResolve
      pendingLookupResolve = null
      if (resolve) {
        const hash = (event.data as LookupResponse).postMappedHash
        resolve(hash ? { postMappedHash: hash } : undefined)
      }
      return
    }

    // Handle custom upload result/error from main thread
    if ('response' in event.data && event.data.response === 'uploadResult') {
      const resolve = pendingUploadResolve
      pendingUploadResolve = null
      pendingUploadReject = null
      resolve?.({ etag: event.data.etag })
      return
    }
    if ('response' in event.data && event.data.response === 'uploadError') {
      const reject = pendingUploadReject
      pendingUploadResolve = null
      pendingUploadReject = null
      reject?.(new Error(event.data.error))
      return
    }

    const data = event.data as MappingRequest
    if (data.request !== 'apply') {
      console.error(`Unknown request ${(data as { request: string }).request}`)
      return
    }

    const { serializedMappingOptions } = data
    const mappingOptions = deserializeMappingOptions(serializedMappingOptions)

    const fileInfo = data.fileInfo
    try {
      curateOne({
        fileInfo,
        outputTarget: data.outputTarget ?? {},
        hashMethod: data.hashMethod,
        hashPartSize: data.hashPartSize,
        mappingOptions,
        previousSourceFileInfo: data.previousFileInfo,
        previousMappedFileInfo: lookupMappedFileInfo,
        // We execute the custom uploader on the main thread.
        // The "custom" flag is just an indicator that the uploader function is provided.
        uploader: data.outputTarget?.custom ? uploadViaMain : undefined,
      })
        .then((mapResults) => {
          // Send finished message for completion
          emit({
            response: 'finished',
            mapResults: mapResults,
          })
        })
        .catch((error) => {
          // also catch promise rejections
          postErrorResponse(error, fileInfo)
        })
    } catch (error) {
      postErrorResponse(error, fileInfo)
      // no need to throw here, it would terminate the worker
    }
  }

  return { handleMessage }
}
