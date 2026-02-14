import { curateOne } from './curateOne'
import { deserializeMappingOptions } from './serializeMappingOptions'
import {
  type TFileInfo,
  type TSerializedMappingOptions,
  type THTTPOptions,
  type TFileInfoIndex,
  type THashMethod,
  OUTPUT_FILE_PREFIX,
} from './types'
import { fixupNodeWorkerEnvironment } from './worker'

export type MappingRequest =
  | {
      request: 'apply'
      fileInfo: TFileInfo
      fileIndex: number
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

let postMappedFileInfo: TFileInfoIndex | undefined

fixupNodeWorkerEnvironment().then(() => {
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
              fileIndex: event.data.fileIndex,
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
                globalThis.postMessage({ response: 'error', error, fileInfo })
              })
          } catch (error) {
            globalThis.postMessage({ response: 'error', error, fileInfo })
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
