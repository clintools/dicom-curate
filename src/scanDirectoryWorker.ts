import { loadS3Client } from './s3Client'
import type { TFileInfo, TFileInfoIndex, TS3BucketOptions } from './types'
import { fixupNodeWorkerEnvironment } from './worker'

// For editor linter to treat the file as an es module, avoiding the error on
// keepScanning being redeclared
export {}

// Case-insensitive filetypes to ALWAYS exclude from processing
const DEFAULT_EXCLUDED_FILETYPES = [
  'dicomdir',
  'dicomdir.dir',
  'dicomdir.dat',
  'dicomdir.bak',
  'thumbs.db',
  '.ds_store',
]

export type FileScanMsg =
  | {
      response: 'file'
      fileIndex: number
      fileInfo: TFileInfo
      previousFileInfo?: {
        size?: number
        mtime?: string
        preMappedHash?: string
      }
    }
  | {
      response: 'scanAnomalies'
      fileIndex: number
      fileInfo: TFileInfo
      anomalies: string[]
      previousFileInfo?: {
        size?: number
        mtime?: string
        preMappedHash?: string
      }
    }
  | {
      response: 'error'
      error: string
    }
  | {
      response: 'done'
    }

export type FileScanRequest =
  | {
      request: 'scan'
      directoryHandle: FileSystemDirectoryHandle
      excludedFiletypes?: string[]
      fileInfoIndex?: TFileInfoIndex
    }
  | {
      request: 'scan'
      path: string
      excludedFiletypes?: string[]
      fileInfoIndex?: TFileInfoIndex
    }
  | {
      request: 'scan'
      excludedFiletypes?: string[]
      bucketOptions: TS3BucketOptions
      fileInfoIndex?: TFileInfoIndex
    }
  | {
      request: 'stop'
    }

let keepScanning = true
let excludedFiletypes: string[] = []
// optional map of previous file info keyed by "path/name"
let previousIndex: Record<string, { size?: number; mtime?: string }> | undefined

/**
 * Check if a file should be processed based on filtering rules
 * @param file - The file to check
 * @param fileAnomalies - Array to collect anomalies for this specific file e.g. excluded files
 * @returns Promise<boolean> - True if the file should be processed
 */
async function shouldProcessFile(
  file: File,
  fileAnomalies: string[],
): Promise<boolean> {
  const allExcludedFiletypes = [
    ...DEFAULT_EXCLUDED_FILETYPES,
    ...excludedFiletypes,
  ]

  try {
    // Check if the file is in the list of excluded files
    if (
      allExcludedFiletypes.some(
        (excluded) => file.name.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${file.name}`)
      return false
    }

    // Check filesize - (valid) DICOM files are at least 132 bytes (128-byte preamble + 4-byte signature)
    if (file.size < 132) {
      fileAnomalies.push(
        `Skipped very small file: ${file.name} (${file.size} bytes)`,
      )
      return false
    }

    // Check for DICOM signature "DICM" at offset 128
    const headerBytes = await file.slice(128, 132).arrayBuffer()
    const headerView = new Uint8Array(headerBytes)
    const dicomSignature = String.fromCharCode(
      headerView[0],
      headerView[1],
      headerView[2],
      headerView[3],
    )
    if (dicomSignature === 'DICM') {
      return true
    }

    // Don't parse file without DICOM signature
    fileAnomalies.push(`Skipped file without DICOM signature: ${file.name}`)
    return false
  } catch (error) {
    fileAnomalies.push(
      `Unable to determine file validity - processing anyway: ${file.name} - ${error}`,
    )
    // If vetting process fails, let the parser decide
    return true
  }
}

async function shouldProcessFileItem(
  s3Item: any,
  fileAnomalies: string[],
): Promise<boolean> {
  try {
    // Check if the file is in the list of excluded files
    if (
      excludedFiletypes.some(
        (excluded) => s3Item.Key.toLowerCase() === excluded.toLowerCase(),
      )
    ) {
      fileAnomalies.push(`Skipped excluded file: ${s3Item.Key}`)
      return false
    }

    // Check filesize - (valid) DICOM files are at least 132 bytes (128-byte preamble + 4-byte signature)
    if (s3Item.Size < 132) {
      fileAnomalies.push(
        `Skipped very small file: ${s3Item.Key} (${s3Item.Size} bytes)`,
      )
      return false
    }

    // Note: We cannot check for DICOM signature without downloading the object,
    // so we skip that check here and let the parser decide later.

    return true
  } catch (error) {
    fileAnomalies.push(
      `Unable to determine file validity - processing anyway: ${s3Item.Key} - ${error}`,
    )
    // If vetting process fails, let the parser decide
    return true
  }
}

fixupNodeWorkerEnvironment().then(() => {
  globalThis.addEventListener('message', (event) => {
    switch (event.data.request) {
      case 'scan': {
        const eventData = event.data as FileScanRequest

        // Optional previous file info index passed in by caller
        if (event.data.fileInfoIndex) {
          previousIndex = event.data.fileInfoIndex
        } else {
          previousIndex = undefined
        }
        // Update excluded filetypes if provided
        if (event.data.excludedFiletypes) {
          excludedFiletypes = event.data.excludedFiletypes
        }
        keepScanning = true

        if ('path' in eventData) {
          scanDirectoryNode(eventData.path)
        } else if ('directoryHandle' in eventData) {
          scanDirectory(eventData.directoryHandle)
        } else if ('bucketOptions' in eventData) {
          scanS3Bucket(eventData.bucketOptions)
        } else {
          console.error('No valid directory information provided for scanning.')
        }
        break
      }
      case 'stop': {
        keepScanning = false
        break
      }
      default:
        console.error(`Unknown request ${event.data.request}`)
    }
  })
})

async function scanS3Bucket(bucketOptions: TS3BucketOptions) {
  try {
    const s3 = await loadS3Client()

    const client = new s3.S3Client({
      region: bucketOptions.region,
      credentials: bucketOptions.credentials,
      endpoint: bucketOptions.endpoint,
      forcePathStyle: bucketOptions.forcePathStyle,
    })

    // Page through the S3 bucket listing using ContinuationToken
    let continuationToken: string | undefined = undefined
    let fileIndex = 0

    do {
      const listCommand = new s3.ListObjectsV2Command({
        Bucket: bucketOptions.bucketName,
        Prefix: bucketOptions.prefix,
        ContinuationToken: continuationToken,
      })

      const data = await client.send(listCommand)

      if (data.Contents) {
        for (const item of data.Contents) {
          const fileAnomalies: string[] = []

          if (
            item.Key &&
            item.Size !== undefined &&
            (await shouldProcessFileItem(item, fileAnomalies))
          ) {
            const prev = previousIndex ? previousIndex[item.Key] : undefined

            globalThis.postMessage({
              response: 'file',
              fileIndex: fileIndex++,
              fileInfo: {
                size: item.Size,
                name: item.Key,
                path: item.Key,
                objectKey: item.Key,
                bucketOptions,
                kind: 's3',
              },
              previousFileInfo: prev,
            } satisfies FileScanMsg)

            fileIndex += 1
          } else if (fileAnomalies.length > 0) {
            const prev = previousIndex ? previousIndex[item.Key!] : undefined
            globalThis.postMessage({
              response: 'scanAnomalies',
              fileIndex: fileIndex++,
              fileInfo: {
                size: item.Size!,
                name: item.Key!,
                path: item.Key!,
                objectKey: item.Key!,
                bucketOptions,
                kind: 's3',
              },
              anomalies: fileAnomalies,
              previousFileInfo: prev,
            } satisfies FileScanMsg)
          }
        }
      }

      // Prepare for next page
      continuationToken = data.NextContinuationToken as string | undefined
    } while (continuationToken)

    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `S3 bucket scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}

async function scanDirectory(dir: FileSystemDirectoryHandle) {
  async function traverse(dir: FileSystemDirectoryHandle, prefix: string) {
    // First, collect sorted dir entries
    const entries = []

    for await (const entry of dir.values()) {
      entries.push(entry)
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    // Assign sorted index to files
    let fileIndex = 0

    for (const entry of entries) {
      if (entry.kind === 'file' && keepScanning) {
        const file = await (entry as FileSystemFileHandle).getFile()
        const fileAnomalies: string[] = []

        if (await shouldProcessFile(file, fileAnomalies)) {
          // Send file to processing pipeline
          const key = `${prefix}/${entry.name}`
          const prev = previousIndex ? previousIndex[key] : undefined
          globalThis.postMessage({
            response: 'file',
            fileIndex: fileIndex++,
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: file.size,
              kind: 'handle',
              fileHandle: entry as FileSystemFileHandle,
            },
            previousFileInfo: prev,
          } satisfies FileScanMsg)
        } else if (fileAnomalies.length > 0) {
          // Send scan anomalies as separate messsage so they are not sent to processing (curate)
          const key = `${prefix}/${entry.name}`
          const prev = previousIndex ? previousIndex[key] : undefined
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileIndex: fileIndex++,
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: file.size,
              kind: 'handle',
              fileHandle: entry as FileSystemFileHandle,
            },
            anomalies: fileAnomalies,
            previousFileInfo: prev,
          } satisfies FileScanMsg)
        }
      } else if (entry.kind === 'directory' && keepScanning) {
        await traverse(
          entry as FileSystemDirectoryHandle,
          prefix + '/' + entry.name,
        )
      }
    }
  }

  try {
    await traverse(dir, dir.name)
    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}

// This function is identical to scanDirectory but works with real filesystem
// paths instead of FileSystemDirectoryHandles
async function scanDirectoryNode(dirPath: string) {
  const fs = await import('fs/promises')
  const path = await import('path')

  async function traverse(currentPath: string, prefix: string) {
    // Read directory entries
    const entries = await fs.readdir(currentPath, { withFileTypes: true })

    // Sort entries by name
    entries.sort((a, b) => a.name.localeCompare(b.name))

    // Assign sorted index to files
    let fileIndex = 0

    for (const entry of entries) {
      if (entry.isFile() && keepScanning) {
        const filePath = path.join(currentPath, entry.name)
        const stats = await fs.stat(filePath)
        const fileBuffer = await fs.readFile(filePath)
        const file = new File([new Uint8Array(fileBuffer)], entry.name, {
          type: 'application/dicom',
        })
        const fileAnomalies: string[] = []

        if (await shouldProcessFile(file, fileAnomalies)) {
          // Send file to processing pipeline
          globalThis.postMessage({
            response: 'file',
            fileIndex: fileIndex++,
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: stats.size,
              kind: 'path',
              fullPath: filePath,
            },
          } satisfies FileScanMsg)
        } else if (fileAnomalies.length > 0) {
          // Send scan anomalies as separate messsage so they are not sent to processing (curate)
          globalThis.postMessage({
            response: 'scanAnomalies',
            fileIndex: fileIndex++,
            fileInfo: {
              path: prefix,
              name: entry.name,
              size: stats.size,
              kind: 'path',
              fullPath: filePath,
            },
            anomalies: fileAnomalies,
          } satisfies FileScanMsg)
        }
      } else if (entry.isDirectory() && keepScanning) {
        await traverse(
          path.join(currentPath, entry.name),
          prefix + '/' + entry.name,
        )
      }
    }
  }

  const dirName = await import('path').then((p) => p.basename(dirPath))
  try {
    await traverse(dirPath, dirName)
    globalThis.postMessage({ response: 'done' } satisfies FileScanMsg)
  } catch (error) {
    globalThis.postMessage({
      response: 'error',
      error: `Directory scan failed: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies FileScanMsg)
  } finally {
    globalThis.close()
  }
}
