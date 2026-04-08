let wt: typeof import('worker_threads') | null = null

// Lazy initialization for Node.js worker_threads
async function initializeNodeWorker() {
  if (!wt) {
    wt = await import('worker_threads')
  }
  return wt
}

// Factory function to create workers in both browser and Node.js environments
export async function createWorker(
  scriptPath: string | URL,
  options?: any,
): Promise<Worker> {
  if (typeof Worker !== 'undefined') {
    // Browser environment
    const urlString = scriptPath.toString()
    const globalAny = globalThis as any

    // Check if we have inlined workers (UMD build with rollup-plugin-web-worker-loader)
    // These globals are set by index.umd.ts
    if (
      urlString.includes('scanDirectoryWorker') &&
      globalAny.__INLINED_SCAN_WORKER__
    ) {
      return new globalAny.__INLINED_SCAN_WORKER__()
    } else if (
      urlString.includes('applyMappingsWorker') &&
      globalAny.__INLINED_MAPPING_WORKER__
    ) {
      return new globalAny.__INLINED_MAPPING_WORKER__()
    }

    // Some packers inline even very large worker scripts as data URLs.
    // Our applyMappingsWorker can get quite large (over 3 MB) and Chrome then refuses
    // to create a worker from it (with an error containing no description).
    // So we convert data URLs to Blob URLs here.
    if (scriptPath instanceof URL && scriptPath.href.startsWith('data:')) {
      scriptPath = dataURLToBlobURL(scriptPath.href)
    }

    // Standard browser Worker creation for ESM builds
    return new Worker(scriptPath, options)
  } else {
    // Node.js environment
    const workerThreads = await initializeNodeWorker()

    // The types aren't entirely compatible, but they are close enough for our use case.
    // We add an 'addEventListener' method to mimic the browser Worker interface.
    const worker = new workerThreads!.Worker(scriptPath, options as any) as any

    worker['addEventListener'] = function (event: any, listener: any) {
      this.on(event, listener)
    }

    return worker as Worker
  }
}

function dataURLToBlobURL(dataURL: string): string {
  const [header, base64] = dataURL.split(',')
  const mimeMatch = header.match(/data:(.*?);base64/)
  const mime = mimeMatch ? mimeMatch[1] : 'text/javascript'

  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

// Maps over the differences between browser and Node.js worker environments
// No-op in browser
export async function fixupNodeWorkerEnvironment() {
  if (typeof Worker === 'undefined') {
    // Only needed in Node.js
    const workerThreads = await initializeNodeWorker()

    globalThis.addEventListener = (event: any, listener: any) => {
      workerThreads!.parentPort?.addEventListener(event, listener)
    }

    globalThis.postMessage = (data: any, transferList?: any) => {
      workerThreads!.parentPort?.postMessage({ data }, transferList)
    }

    globalThis.close = () => {
      workerThreads!.parentPort?.close()
    }
  }
}
