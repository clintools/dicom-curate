/**
 * Lazy Blob backed by a byte range within a file on disk. `stream()` opens a
 * new `fs.createReadStream` on every call so the file is never fully loaded
 * into memory. Extends the native `Blob` so that `instanceof Blob` checks in
 * undici's fetch pass and `Content-Length` is set correctly from `size`.
 */
export class LazyFileBlob extends Blob {
  // Declared to satisfy TypeScript; actual value is set via Object.defineProperty
  // in the constructor to shadow the empty underlying Blob's size.
  declare readonly size: number

  constructor(
    private readonly filePath: string,
    private readonly fileStart: number,
    size: number,
    type = 'application/octet-stream',
  ) {
    super([], { type })
    Object.defineProperty(this, 'size', { value: size, configurable: true })
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const { filePath, fileStart, size } = this
    // rs is set during start() and used by pull() and cancel().
    let rs: import('fs').ReadStream | undefined
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        if (size === 0) {
          controller.close()
          return
        }
        return import('node:fs').then(({ createReadStream }) => {
          rs = createReadStream(filePath, {
            start: fileStart,
            end: fileStart + size - 1,
          })
          // Start paused; pull() will resume when the consumer is ready.
          rs.pause()
          rs.on('data', (chunk: string | Buffer) => {
            // Pause immediately so the next resume only happens when the
            // ReadableStream controller asks for more via pull().
            rs!.pause()
            // createReadStream without setEncoding() always yields Buffer.
            // Buffer is a Uint8Array subclass — create a zero-copy view of
            // its underlying ArrayBuffer rather than copying.
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            controller.enqueue(
              new Uint8Array(
                buf.buffer,
                buf.byteOffset,
                buf.byteLength,
              ) as unknown as Uint8Array<ArrayBuffer>,
            )
          })
          rs.on('end', () => controller.close())
          rs.on('error', (err) => controller.error(err))
        })
      },
      pull() {
        rs?.resume()
      },
      cancel() {
        rs?.destroy()
      },
    })
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = []
    for await (const chunk of readableStreamToAsyncIterable(this.stream())) {
      chunks.push(chunk)
    }
    const total = chunks.reduce((s, c) => s + c.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out.buffer as ArrayBuffer
  }

  override slice(start = 0, end?: number, type = ''): Blob {
    const norm = (v: number) =>
      v < 0 ? Math.max(0, this.size + v) : Math.min(v, this.size)
    const s = norm(start)
    const e = norm(end ?? this.size)
    return new LazyFileBlob(
      this.filePath,
      this.fileStart + s,
      Math.max(0, e - s),
      type,
    )
  }
}

/**
 * Lazy composite Blob: an in-memory DICOM header buffer followed by a lazy
 * file Blob (pixel data). Avoids loading pixel data into memory when only the
 * DICOM header has changed. Like `LazyFileBlob`, extends native `Blob` so
 * that fetch body handling works correctly.
 */
export class LazyCompositeBlob extends Blob {
  declare readonly size: number

  constructor(
    private readonly headerBuf: ArrayBuffer,
    private readonly pixelDataBlob: Blob,
    type = 'application/octet-stream',
  ) {
    super([], { type })
    Object.defineProperty(this, 'size', {
      value: headerBuf.byteLength + pixelDataBlob.size,
      configurable: true,
    })
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const { headerBuf, pixelDataBlob } = this
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      // start() may return a Promise — the stream won't close until it resolves.
      async start(controller) {
        controller.enqueue(
          new Uint8Array(headerBuf) as unknown as Uint8Array<ArrayBuffer>,
        )
        for await (const chunk of readableStreamToAsyncIterable(
          pixelDataBlob.stream(),
        )) {
          controller.enqueue(chunk as unknown as Uint8Array<ArrayBuffer>)
        }
        controller.close()
      },
    })
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [new Uint8Array(this.headerBuf)]
    for await (const chunk of readableStreamToAsyncIterable(
      this.pixelDataBlob.stream(),
    )) {
      chunks.push(chunk)
    }
    const total = chunks.reduce((s, c) => s + c.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out.buffer as ArrayBuffer
  }
}

export async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Wraps a ReadableStream as an async iterable with an explicit cancel hook.
 * Used to stop feeding dcmjs once header parsing finishes; otherwise
 * `fromAsyncStream` would buffer the entire file (including PixelData).
 */
export function cancellableReadableStreamIterable(
  stream: ReadableStream<Uint8Array>,
): {
  iterable: AsyncIterable<Uint8Array>
  cancel: () => Promise<void>
} {
  const reader = stream.getReader()
  let cancelled = false

  const iterable = (async function* () {
    try {
      while (!cancelled) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  })()

  return {
    iterable,
    cancel: async () => {
      cancelled = true
      await reader.cancel().catch(() => {})
    },
  }
}
