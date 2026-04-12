import * as dcmjs from 'dcmjs'
import { composeSpecs } from './composeSpecs'
import {
  LazyCompositeBlob,
  LazyFileBlob,
  readableStreamToAsyncIterable,
} from './blobUtil'
import createNestedDirectories from './createNestedDirectories'
import curateDict from './curateDict'
import { fetchWithRetry } from './fetchWithRetry'
import { loadLibStorage } from './libStorage'
import { hash, hashStream } from './hash'
import { loadS3Client } from './s3Client'
import type {
  TFileInfo,
  THashMethod,
  TMappingOptions,
  TMapResults,
  TOutputTarget,
} from './types'

export type TCurateOneArgs = {
  fileInfo: TFileInfo
  outputTarget: TOutputTarget
  mappingOptions: TMappingOptions
  // hash algorithm to use when previousSourceFileInfo is provided. Defaults to 'md5'.
  // Supported values: 'md5', 'aws-s3-etag-2025', 'crc64' (NVMe-style), 'crc32', or 'sha256'.
  hashMethod?: THashMethod
  // Part size (in bytes) for 'aws-s3-etag-2025' hash method. Defaults to 5 MB.
  hashPartSize?: number
  // If provided, curateOne() will skip processing the file if the passed values
  // match the current properties of the input file.
  previousSourceFileInfo?: {
    size?: number
    mtime?: string
    preMappedHash?: string
  }
  // The caller may not know the name of the mapped file in advance
  // so this callback can be used to provide previous mapped file info by mapped name
  // once it is known.
  // If this callback is provided and it returns a postMappedHash that matches
  // what curateOne generated, then the output file is not written again.
  previousMappedFileInfo?: (mappedFileName: string) => Promise<
    | {
        postMappedHash?: string
      }
    | undefined
  >
}

function specHasFilter(mappingOptions: TMappingOptions): boolean {
  if (mappingOptions.curationSpec === 'none') return false
  const composed = composeSpecs(mappingOptions.curationSpec())
  return !!(composed.preExclude ?? composed.postExclude)
}

export async function curateOne({
  fileInfo,
  outputTarget,
  mappingOptions,
  hashMethod,
  hashPartSize,
  previousSourceFileInfo,
  previousMappedFileInfo,
}: TCurateOneArgs): Promise<
  // anomalies is minimally present.
  Omit<Partial<TMapResults>, 'anomalies'> & {
    anomalies: TMapResults['anomalies']
  }
> {
  const startTime = performance.now()
  let mtime: string | undefined

  // 1) Read the file (from handle or blob)
  let file: Blob
  if (fileInfo.kind === 'blob') {
    file = fileInfo.blob
  } else if (fileInfo.kind === 'path') {
    // Node.js environment — stat the file for size/mtime, then wrap it in a
    // LazyFileBlob so the contents are streamed on demand rather than loaded
    // into memory up-front.
    const { stat } = await import('node:fs').then((m) => m.promises)
    const fileStats = await stat(fileInfo.fullPath)
    mtime = new Date(fileStats.mtimeMs).toISOString()
    file = new LazyFileBlob(fileInfo.fullPath, 0, fileStats.size)
  } else if (fileInfo.kind === 'http') {
    const headers: Record<string, string> = {}
    if (fileInfo.headers) {
      Object.assign(headers, fileInfo.headers)
    }
    const resp = await fetch(fileInfo.url, { headers })
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch ${fileInfo.url}: ${resp.status} ${resp.statusText}`,
      )
    }
    file = await resp.blob()

    const lastModifiedHeader = resp.headers.get('last-modified')
    if (lastModifiedHeader) {
      mtime = new Date(lastModifiedHeader).toISOString()
    }
  } else if (fileInfo.kind === 's3') {
    // Dynamically import AWS SDK S3 client
    const s3 = await loadS3Client()

    const client = new s3.S3Client({
      region: fileInfo.bucketOptions.region,
      credentials: fileInfo.bucketOptions.credentials,
      endpoint: fileInfo.bucketOptions.endpoint,
      forcePathStyle: fileInfo.bucketOptions.forcePathStyle,
    })
    const fetchResponse = await client.send(
      new s3.GetObjectCommand({
        Bucket: fileInfo.bucketOptions.bucketName,
        Key: fileInfo.objectKey,
      }),
    )

    if (!fetchResponse.Body) {
      throw new Error(
        `Failed to fetch s3://${fileInfo.bucketOptions.bucketName}/${fileInfo.objectKey}: No data returned`,
      )
    }

    // Convert the response Body (a stream) into a Blob
    // The data type of Body is rather complex.
    const streamToBlob = async (stream: AsyncIterable<any>): Promise<Blob> => {
      const chunks: Uint8Array[] = []

      for await (const chunk of stream as AsyncIterable<any>) {
        let u8: Uint8Array

        if (typeof chunk === 'string') {
          u8 = new TextEncoder().encode(chunk)
        } else if (chunk instanceof ArrayBuffer) {
          u8 = new Uint8Array(chunk)
        } else if (ArrayBuffer.isView(chunk)) {
          const view = chunk as ArrayBufferView
          u8 = new Uint8Array(
            view.buffer,
            (view as any).byteOffset ?? 0,
            view.byteLength,
          )
        } else {
          // Fallback - attempt to convert to Uint8Array
          try {
            u8 = new Uint8Array(chunk)
          } catch (e) {
            // If conversion fails, skip this chunk
            continue
          }
        }

        chunks.push(u8)
      }

      return new Blob(chunks as any, { type: 'application/octet-stream' })
    }

    file = await streamToBlob(fetchResponse.Body as any)

    const lastModified = fetchResponse.LastModified
    if (lastModified) {
      mtime = new Date(lastModified).toISOString()
    }
  } else {
    file = await fileInfo.fileHandle.getFile()
  }

  // 2) extract mtime if available
  if (!mtime) {
    try {
      const maybeFile = file as File
      if (maybeFile && typeof (maybeFile as any).lastModified === 'number') {
        mtime = new Date((maybeFile as any).lastModified).toISOString()
      }
    } catch (e) {
      // ignore
    }
  }

  let preMappedHash: string | undefined
  let postMappedHash: string | undefined
  const postMappedHashHeader = 'x-source-file-hash'

  // 4) decide if we can skip mapping based on previousSourceFileInfo
  let canSkip = false

  if (previousSourceFileInfo?.preMappedHash !== undefined) {
    try {
      // choose hashing algorithm: default to md5 for S3 ETag compatibility
      preMappedHash = await hashStream(
        file.stream() as unknown as AsyncIterable<Uint8Array>,
        hashMethod ?? 'md5',
        hashPartSize,
      )
    } catch (e) {
      console.warn(`Failed to compute preMappedHash for ${fileInfo.name}`, e)
    }

    if (preMappedHash !== undefined) {
      canSkip = previousSourceFileInfo.preMappedHash === preMappedHash
    }
  }

  if (!canSkip) {
    // basic: only size+mtime
    if (
      previousSourceFileInfo?.size !== undefined &&
      previousSourceFileInfo?.mtime !== undefined
    ) {
      canSkip =
        previousSourceFileInfo.size === fileInfo.size &&
        previousSourceFileInfo.mtime === mtime
    }
  }

  const noMapResult = (
    outputFilePath?: string,
    knownPostMappedHash?: string,
  ) => {
    const retval: TMapResults = {
      sourceInstanceUID: `unchanged_${fileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
      mappings: {},
      anomalies: [],
      errors: [],
      quarantine: {},
      mappingRequired: false,
      fileInfo: {
        name: fileInfo.name,
        size: fileInfo.size,
        path: fileInfo.path,
        mtime: previousSourceFileInfo?.mtime,
        preMappedHash: preMappedHash,
        ...(knownPostMappedHash !== undefined && {
          postMappedHash: knownPostMappedHash,
        }),
      },
      // include curationTime even when skipped to measure hashing/check time
      curationTime: performance.now() - startTime,
      outputFilePath,
    }
    return retval
  }

  const hasFilter = specHasFilter(mappingOptions)

  if (canSkip && previousSourceFileInfo && !hasFilter) {
    return noMapResult()
  }

  // 5) parse DICOM
  let mappedDicomData: {
    write: (...args: any[]) => ArrayBuffer | Blob | Promise<ArrayBuffer | Blob>
  }
  let clonedMapResults: TMapResults

  if (mappingOptions.curationSpec !== 'none') {
    dcmjs.log.setLevel(dcmjs.log.levels.ERROR)
    dcmjs.log.getLogger('validation.dcmjs').setLevel(dcmjs.log.levels.SILENT)
    let dicomData: dcmjs.data.DicomDict
    let pixelDataOffset = -1
    try {
      const reader = new dcmjs.async.AsyncDicomReader()
      const feedDone = reader.stream.fromAsyncStream(
        readableStreamToAsyncIterable(file.stream()),
      )
      await reader.readFile({
        ignoreErrors: true,
        noCopy: true,
        untilTag: '7FE00010',
      })
      await feedDone
      // readTagHeader consumes the 4-byte tag identifier before detecting untilTag,
      // so subtract 4 to recover the tag's start offset in the original file.
      const rawOffset = reader.stream.offset - 4
      if (rawOffset > 0 && rawOffset < file.size) {
        pixelDataOffset = rawOffset
      }
      dicomData = new dcmjs.data.DicomDict(reader.meta)
      dicomData.dict = reader.dict
    } catch (error) {
      console.warn(
        `[dicom-curate] Could not parse ${fileInfo.name} as DICOM data:`,
        error,
      )
      const mapResults = {
        anomalies: [`Could not parse ${fileInfo.name} as DICOM data`],
        errors: [
          `File ${fileInfo.name} is not a valid DICOM file or is corrupted`,
        ],
        sourceInstanceUID: `invalid_${fileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
        fileInfo: {
          name: fileInfo.name,
          size: fileInfo.size,
          path: fileInfo.path,
          mtime,
          preMappedHash,
          parseError: error instanceof Error ? error.message : String(error),
        },
        curationTime: performance.now() - startTime,
      }

      return mapResults
    }
    // 6) perform mapping

    ;({ dicomData: mappedDicomData, mapResults: clonedMapResults } = curateDict(
      `${fileInfo.path}/${fileInfo.name}`,
      dicomData,
      mappingOptions,
    ))

    // If the spec produced no DICOM header changes, short-circuit to
    // preserve the original file bytes (the dcmjs round-trip is not byte-preserving).
    if (Object.keys(clonedMapResults.mappings).length === 0) {
      mappedDicomData = {
        write: () => file,
      }
    } else if (pixelDataOffset >= 0) {
      // Append PixelData from the original file as a zero-copy Blob slice.
      // dcmjs never saw the pixel data (untilTag stopped it), so its write()
      // output is header-only; we append the original bytes from pixelDataOffset.
      const origWrite = mappedDicomData.write.bind(mappedDicomData)
      mappedDicomData = {
        write: (options?: any) => {
          const headerBuf = origWrite(options) as ArrayBuffer
          return new LazyCompositeBlob(headerBuf, file.slice(pixelDataOffset))
        },
      }
    }

    // File excluded by preExclude or postExclude — skip write and return immediately.
    if (clonedMapResults.excluded) {
      clonedMapResults.mappingRequired = false
      clonedMapResults.fileInfo = {
        name: fileInfo.name,
        size: fileInfo.size,
        path: fileInfo.path,
        mtime,
        preMappedHash,
      }
      clonedMapResults.curationTime = performance.now() - startTime
      return clonedMapResults
    }

    // Indicate that mapping was required (we didn't hit the early-skip branch above)
    // Previously mappingRequired was only set to false when skipping; ensure it's
    // explicitly set to true when mapping was performed so consumers can rely on
    // the flag being present in both cases.
    clonedMapResults.mappingRequired = true
  } else {
    // If curationSpec is 'none', we skip all mapping and just pass through the original data with minimal mapResults
    mappedDicomData = {
      write: () => file,
    }
    clonedMapResults = {
      sourceInstanceUID: `passthrough_${fileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
      mappings: {},
      anomalies: [],
      errors: [],
      quarantine: {},
      fileInfo: {
        name: fileInfo.name,
        size: fileInfo.size,
        path: fileInfo.path,
        mtime,
        preMappedHash,
      },
      outputFilePath: `${fileInfo.path}/${fileInfo.name}`,
      mappingRequired: false,
    }
  }

  // If we didn't compute preMappedHash yet, do it now
  if (!preMappedHash) {
    try {
      // choose hashing algorithm: default to md5 for S3 ETag compatibility
      preMappedHash = await hashStream(
        readableStreamToAsyncIterable(file.stream()),
        hashMethod ?? 'md5',
        hashPartSize,
      )
    } catch (e) {
      console.warn(`Failed to compute preMappedHash for ${fileInfo.name}`, e)
    }
  }

  // 7) write output if requested
  if (!mappingOptions.skipWrite) {
    const dirPath = clonedMapResults
      .outputFilePath!.split('/')
      .slice(0, -1)
      .join('/')
    const fileName = clonedMapResults.outputFilePath!.split('/').slice(-1)[0]

    const modifiedData = await mappedDicomData.write({
      allowInvalidVRLength: true,
    })
    // Normalize to Blob so all downstream paths stream rather than holding
    // the full file in memory.  When write() already returns a Blob (zero-copy
    // header+pixel-data concat) no extra copy is made here.
    const modifiedBlob: Blob =
      modifiedData instanceof Blob
        ? modifiedData
        : new Blob([modifiedData], { type: 'application/octet-stream' })

    // Stream through once for hashing — no full materialization.
    postMappedHash = await hashStream(
      readableStreamToAsyncIterable(modifiedBlob.stream()),
      hashMethod ?? 'md5',
      hashPartSize,
    )

    const previousPostMappedHash = previousMappedFileInfo
      ? (await previousMappedFileInfo(clonedMapResults.outputFilePath!))
          ?.postMappedHash
      : undefined

    if (
      previousPostMappedHash !== undefined &&
      previousPostMappedHash === postMappedHash
    ) {
      return noMapResult(clonedMapResults.outputFilePath, postMappedHash)
    }

    // Check if outputTarget.directory is a FileSystemDirectoryHandle (browser) or string (Node.js)
    if (
      typeof outputTarget?.directory === 'object' &&
      'getFileHandle' in outputTarget.directory
    ) {
      const subDirectoryHandle = await createNestedDirectories(
        outputTarget.directory,
        dirPath,
      )
      if (subDirectoryHandle === false) {
        console.error(`Cannot create directory for ${dirPath}`)
      } else {
        const fileHandle = await subDirectoryHandle.getFileHandle(fileName, {
          create: true,
        })
        const writable = await fileHandle.createWritable()
        await writable.write(modifiedBlob)
        await writable.close()
      }
    } else if (typeof outputTarget?.directory === 'string') {
      // Node.js environment - use fs module to write file
      const fs = await import('fs').then((mod) => mod.promises)
      const path = await import('path')
      const fullDirPath = path.resolve(outputTarget?.directory, dirPath)

      try {
        await fs.mkdir(fullDirPath, { recursive: true })
      } catch (error) {
        console.error(`Cannot create directory for ${fullDirPath}:`, error)
        return clonedMapResults
      }

      const fullFilePath = path.join(fullDirPath, fileName)
      await fs.writeFile(fullFilePath, modifiedBlob.stream() as any)
    } else if (!outputTarget?.http && !outputTarget?.s3) {
      // Only create mappedBlob when there is no output target at all (no
      // directory, no HTTP endpoint, no S3 bucket). When an upload target is
      // present the blob has already been consumed and keeping it around
      // retains the full file content in memory for every processed file,
      // causing OOM crashes at scale.
      clonedMapResults.mappedBlob = modifiedBlob
    }

    // If upload URL (bucket) is provided, perform an HTTP PUT upload to the server
    if (outputTarget?.http) {
      try {
        // Encode each part of the path, but not the slashes
        const key = clonedMapResults
          .outputFilePath!.split('/')
          .map(encodeURIComponent)
          .join('/')

        // Combine the full upload URL by appending the bucket URL + optional prefix + file name (key)
        const uploadUrl = `${outputTarget.http.url}/${key}`

        // Create headers per helper described by the user
        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': fileName,
          'X-File-Type': 'application/octet-stream',
          'X-File-Size': String(modifiedBlob.size),
          'X-Source-File-Size': String(clonedMapResults.fileInfo?.size ?? ''),
          'X-Source-File-Modified-Time': mtime ?? '',
          'X-Source-File-Hash': preMappedHash ?? '',
        }

        if (outputTarget.http.headers) {
          Object.assign(headers, outputTarget.http.headers)
        }

        if (postMappedHashHeader && postMappedHash)
          headers[postMappedHashHeader] = postMappedHash

        const resp = await fetchWithRetry(uploadUrl, {
          method: 'PUT',
          headers,
          body: modifiedBlob,
        })

        if (!resp.ok) {
          console.error(
            `Upload failed for ${uploadUrl}: ${resp.status} ${resp.statusText}`,
          )
          clonedMapResults.uploadErrors = clonedMapResults.uploadErrors ?? []
          clonedMapResults.uploadErrors.push(
            `Upload failed: ${resp.status} ${resp.statusText}`,
          )
        } else {
          // attach upload info if available
          const etag = resp.headers.get('etag') ?? undefined
          clonedMapResults.outputUpload = clonedMapResults.outputUpload ?? {
            url: uploadUrl,
            status: resp.status,
            etag,
          }
        }
      } catch (e) {
        console.error('Upload error', e)
        clonedMapResults.uploadErrors = clonedMapResults.uploadErrors ?? []
        clonedMapResults.uploadErrors.push(
          `Upload error: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    } else if (outputTarget?.s3) {
      // Dynamically import AWS SDK S3 client and lib-storage Upload helper
      const s3 = await loadS3Client()
      const libStorage = await loadLibStorage()

      const client = new s3.S3Client({
        region: outputTarget.s3.region,
        credentials: outputTarget.s3.credentials,
        endpoint: outputTarget.s3.endpoint,
        forcePathStyle: outputTarget.s3.forcePathStyle,
      })

      try {
        const prefix = outputTarget.s3.prefix
          ? outputTarget.s3.prefix.endsWith('/')
            ? outputTarget.s3.prefix
            : outputTarget.s3.prefix + '/'
          : ''
        const key = prefix + clonedMapResults.outputFilePath!

        // Always route through lib-storage. When `uploadPartSize` is set,
        // bodies larger than that value are uploaded via multipart and S3
        // assigns a composite `<md5>-<N>` ETag; smaller bodies go through
        // a single PutObject internally and get a plain-MD5 ETag. When
        // `uploadPartSize` is undefined, we pass MAX_SAFE_INTEGER so every
        // body fits in "one part" and lib-storage always falls back to a
        // single PutObject — behaviourally identical to sending
        // `PutObjectCommand` directly, but keeps the upload path uniform.
        const partSize =
          outputTarget.s3.uploadPartSize ?? Number.MAX_SAFE_INTEGER

        const upload = new libStorage.Upload({
          client,
          params: {
            Bucket: outputTarget.s3.bucketName,
            Key: key,
            Body: modifiedBlob.stream(),
            ContentLength: modifiedBlob.size,
            ContentType: 'application/octet-stream',
            Metadata: {
              'source-file-size': String(clonedMapResults.fileInfo?.size ?? ''),
              'source-file-modified-time': mtime ?? '',
              'source-file-hash': preMappedHash ?? '',
              ...(postMappedHash
                ? { 'source-file-post-mapped-hash': postMappedHash }
                : {}),
            },
          },
          partSize,
        })
        const uploadResponse = await upload.done()

        const uploadUrl = `s3://${outputTarget.s3.bucketName}/${key}`
        // attach upload info
        clonedMapResults.outputUpload = {
          url: uploadUrl,
          status: 200,
          etag: uploadResponse.ETag ?? undefined,
        }
      } catch (e) {
        console.error('S3 Upload error', e)
        clonedMapResults.uploadErrors = clonedMapResults.uploadErrors ?? []
        clonedMapResults.uploadErrors.push(
          `S3 Upload error: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  // 8) attach fileInfo and return
  clonedMapResults.fileInfo = {
    name: fileInfo.name,
    size: fileInfo.size,
    path: fileInfo.path,
    mtime,
    preMappedHash,
    postMappedHash,
  }

  clonedMapResults.curationTime = performance.now() - startTime

  return clonedMapResults
}
