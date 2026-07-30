import {
  type FileScanMsg,
  type FileScanRequest,
  type PreviousFileIndex,
  ScanController,
  type ScanFilters,
  scanDirectory,
  scanDirectoryNode,
  scanS3Bucket,
} from './scanCore'
import { fixupNodeWorkerEnvironment } from './worker'

// Re-exported so existing importers keep their paths; defined in scanCore.ts.
export type { FileScanMsg, FileScanRequest } from './scanCore'
export { isS3KeyExcludedByName } from './scanCore'

// Thread wiring only: scanning logic lives in scanCore.ts so it can be
// unit-tested in-process.

// Controller for the scan in flight, so 'stop'/'resume' can act on it.
let currentController: ScanController | null = null

function emit(msg: FileScanMsg): void {
  globalThis.postMessage(msg)
}

fixupNodeWorkerEnvironment().then(() => {
  globalThis.addEventListener('message', (event) => {
    switch (event.data.request) {
      case 'scan': {
        const eventData = event.data as FileScanRequest & { request: 'scan' }

        const previousIndex = eventData.fileInfoIndex as
          | PreviousFileIndex
          | undefined

        const filters: ScanFilters = {
          excludedFiletypes: eventData.excludedFiletypes ?? [],
          // Compile excluded path regex strings (converted from globs in the main thread)
          excludedPathRegexes: (eventData.excludedPathRegexes ?? []).map(
            (pattern: string) => new RegExp(pattern),
          ),
          noDicomSignatureCheck: eventData.noDicomSignatureCheck ?? false,
          noDefaultExclusions: eventData.noDefaultExclusions ?? false,
        }

        const controller = new ScanController()
        currentController = controller
        const ctx = { filters, controller, previousIndex, emit }

        let scan: Promise<void>
        if ('path' in eventData) {
          scan = scanDirectoryNode(eventData.path, ctx)
        } else if ('directoryHandle' in eventData) {
          scan = scanDirectory(eventData.directoryHandle, ctx)
        } else if ('bucketOptions' in eventData) {
          scan = scanS3Bucket(eventData.bucketOptions, ctx)
        } else {
          console.error('No valid directory information provided for scanning.')
          break
        }

        // The traversal always emits its own 'done'/'error' before resolving;
        // close the port once it settles so the worker can be reused/torn down.
        scan.finally(() => {
          globalThis.close()
        })
        break
      }
      case 'stop': {
        // Pause the feeder — the counter is NOT affected by backpressure
        currentController?.pause()
        break
      }
      case 'resume': {
        // Resume the feeder
        currentController?.resume()
        break
      }
      default:
        console.error(`Unknown request ${event.data.request}`)
    }
  })
})
