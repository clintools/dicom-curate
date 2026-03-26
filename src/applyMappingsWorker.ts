import { curateOne } from './curateOne'
import { deserializeMappingOptions } from './serializeMappingOptions'
import {
  type TFileInfo,
  type THashMethod,
  type TOutputTarget,
  type TSerializedMappingOptions,
} from './types'
import { fixupNodeWorkerEnvironment } from './worker'

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

/**
 * Safely serialize an error for postMessage to avoid DataCloneError.
 * Some error objects contain non-cloneable properties (circular references,
 * native handles, etc.) that cause postMessage to throw.
 */
function safeSerializeError(error: unknown): string {
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
 * Send an error response back to the main thread. Uses safeSerializeError
 * to prevent DataCloneError from causing the worker to die silently.
 */
function postErrorResponse(error: unknown, fileInfo: TFileInfo): void {
  try {
    globalThis.postMessage({
      response: 'error',
      error: safeSerializeError(error),
      fileInfo,
    })
  } catch {
    // Last resort: if even the safe serialization fails, send a minimal response
    // so the main thread can recover the worker slot.
    globalThis.postMessage({
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
    globalThis.postMessage({
      response: 'lookup',
      outputPath,
    })
  })
}

fixupNodeWorkerEnvironment()
  .then(() => {
    globalThis.addEventListener(
      'message',
      (event: MessageEvent<MappingRequest | LookupResponse>) => {
        // Handle lookup response from main thread
        if (
          'response' in event.data &&
          event.data.response === 'lookupResult'
        ) {
          const resolve = pendingLookupResolve
          pendingLookupResolve = null
          if (resolve) {
            const hash = (event.data as LookupResponse).postMappedHash
            resolve(hash ? { postMappedHash: hash } : undefined)
          }
          return
        }

        const data = event.data as MappingRequest
        if (data.request !== 'apply') {
          console.error(
            `Unknown request ${(data as { request: string }).request}`,
          )
          return
        }

        const { serializedMappingOptions } = data
        const mappingOptions = deserializeMappingOptions(
          serializedMappingOptions,
        )

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
          })
            .then((mapResults) => {
              // Send finished message for completion
              globalThis.postMessage({
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
      },
    )
  })
  .catch((error) => {
    // If fixupNodeWorkerEnvironment() fails, the worker can never process
    // messages. Log the error so it's visible in the console.
    console.error('Failed to initialize mapping worker environment:', error)
  })
