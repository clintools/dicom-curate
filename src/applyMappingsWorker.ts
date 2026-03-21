import { curateOne } from './curateOne'
import { deserializeMappingOptions } from './serializeMappingOptions'
import {
  OUTPUT_FILE_PREFIX,
  type TFileInfo,
  type TFileInfoIndex,
  type THashMethod,
  type THTTPOptions,
  type TSerializedMappingOptions,
} from './types'
import { fixupNodeWorkerEnvironment } from './worker'

export type MappingRequest =
  | {
      request: 'apply'
      fileInfo: TFileInfo
      outputTarget?: {
        http?: THTTPOptions
        directory?: FileSystemDirectoryHandle | string
      }
      previousFileInfo?: {
        size?: number
        mtime?: string
        preMappedHash?: string
      }
      hashMethod?: THashMethod
      serializedMappingOptions: TSerializedMappingOptions
    }
  | {
      request: 'fileInfoIndex'
      fileInfoIndex?: TFileInfoIndex
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

let postMappedFileInfo: TFileInfoIndex | undefined

fixupNodeWorkerEnvironment()
  .then(() => {
    globalThis.addEventListener(
      'message',
      (event: MessageEvent<MappingRequest>) => {
        switch (event.data.request) {
          case 'fileInfoIndex': {
            postMappedFileInfo = event.data.fileInfoIndex
            break
          }
          case 'apply': {
            const { serializedMappingOptions } = event.data
            const mappingOptions = deserializeMappingOptions(
              serializedMappingOptions,
            )

            const fileInfo = event.data.fileInfo
            try {
              curateOne({
                fileInfo,
                outputTarget: event.data.outputTarget || {},
                hashMethod: event.data.hashMethod,
                mappingOptions,
                previousSourceFileInfo: event.data.previousFileInfo,
                previousMappedFileInfo: (targetName) => {
                  const hash =
                    postMappedFileInfo?.[OUTPUT_FILE_PREFIX + targetName]
                  return hash
                },
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
            break
          }
          default:
            console.error(`Unknown request ${(event.data as any).request}`)
        }
      },
    )
  })
  .catch((error) => {
    // If fixupNodeWorkerEnvironment() fails, the worker can never process
    // messages. Log the error so it's visible in the console.
    console.error('Failed to initialize mapping worker environment:', error)
  })
