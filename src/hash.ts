import { md5 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createModel } from 'js-crc'
import type { THashMethod } from './types'

const DEFAULT_HASH_PART_SIZE = 5 * 1024 * 1024 // 5 MB — matches @aws-sdk/lib-storage default

export async function hash(
  buffer: ArrayBuffer,
  hashMethod: THashMethod,
  hashPartSize?: number,
): Promise<string> {
  switch (hashMethod) {
    case 'sha256':
      return sha256Hex(buffer)
    case 'crc32':
      return crc32Hex(buffer)
    case 'crc64':
      return crc64Hex(buffer)
    case 'aws-s3-etag-2025':
      return awsS3Etag(buffer, hashPartSize ?? DEFAULT_HASH_PART_SIZE)
    case 'md5':
      return md5Hex(buffer)
    default:
      return md5Hex(buffer)
  }
}

/**
 * Computes a hash over a stream of data chunks without materializing the full
 * data into memory at once.
 *
 * md5/sha256: uses @noble/hashes for true incremental hashing in all
 * environments (Node.js and browser).
 * crc32/crc64: always collects chunks (js-crc has no incremental API), but
 * these aren't typically used on image-sized files.
 * aws-s3-etag-2025: streaming multi-part MD5 — each part is hashed
 * incrementally; no part buffer is ever materialized in memory.
 */
export async function hashStream(
  stream: AsyncIterable<Uint8Array>,
  hashMethod: THashMethod,
  hashPartSize?: number,
): Promise<string> {
  switch (hashMethod) {
    case 'sha256':
      return sha256HexStream(stream)
    case 'crc32':
      return crc32Hex(await collectStream(stream))
    case 'crc64':
      return crc64Hex(await collectStream(stream))
    case 'aws-s3-etag-2025':
      return awsS3EtagStream(stream, hashPartSize ?? DEFAULT_HASH_PART_SIZE)
    case 'md5':
    default:
      return md5HexStream(stream)
  }
}

/** Drain a stream into a single contiguous Uint8Array. Used as fallback for
 *  algorithms that lack an incremental API. */
async function collectStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const chunk of chunks) {
    out.set(chunk, off)
    off += chunk.byteLength
  }
  return out
}

/** True streaming MD5 via @noble/hashes — works in Node.js and browsers. */
async function md5HexStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const h = md5.create()
  for await (const chunk of stream) h.update(chunk)
  return bytesToHex(h.digest())
}

/** True streaming SHA-256 via @noble/hashes — works in Node.js and browsers. */
async function sha256HexStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const h = sha256.create()
  for await (const chunk of stream) h.update(chunk)
  return bytesToHex(h.digest())
}

/**
 * Streaming S3 multipart ETag computation.
 *
 * - If total bytes <= partSize: returns plain MD5 (matches PUT Object ETag).
 * - Otherwise: returns `md5(concat(rawMd5s))-N` (matches multipart upload ETag).
 *
 * Each part is hashed incrementally as chunks arrive — no part buffer is ever
 * materialized, so peak memory is O(chunk size) rather than O(part size).
 */
async function awsS3EtagStream(
  stream: AsyncIterable<Uint8Array>,
  partSize: number,
): Promise<string> {
  const partRawDigests: Uint8Array[] = []
  let partHasher = md5.create()
  let currentPartBytes = 0
  let totalBytes = 0

  function finalizeCurrentPart(): void {
    partRawDigests.push(partHasher.digest())
    partHasher = md5.create()
    currentPartBytes = 0
  }

  for await (const chunk of stream) {
    totalBytes += chunk.byteLength
    let pos = 0
    while (pos < chunk.byteLength) {
      const space = partSize - currentPartBytes
      const take = Math.min(chunk.byteLength - pos, space)
      partHasher.update(chunk.subarray(pos, pos + take))
      currentPartBytes += take
      pos += take
      if (currentPartBytes === partSize) {
        finalizeCurrentPart()
      }
    }
  }

  if (currentPartBytes > 0) {
    finalizeCurrentPart()
  }

  if (partRawDigests.length === 0) {
    return bytesToHex(md5(new Uint8Array(0)))
  }

  if (totalBytes <= partSize) {
    // Single-part: plain MD5 (not multipart format)
    return bytesToHex(partRawDigests[0])
  }

  const combined = new Uint8Array(partRawDigests.length * 16)
  partRawDigests.forEach((d, i) => {
    combined.set(d, i * 16)
  })
  return `${bytesToHex(md5(combined))}-${partRawDigests.length}`
}

function sha256Hex(buffer: ArrayBuffer): string {
  return bytesToHex(sha256(new Uint8Array(buffer)))
}

function md5Hex(buffer: ArrayBuffer): string {
  return bytesToHex(md5(new Uint8Array(buffer)))
}

/**
 * Compute a hash that matches the S3 ETag for the given buffer.
 *
 * - Single-part (buffer.byteLength <= partSize): plain MD5 hex string.
 *   This matches the documented S3 ETag behaviour for objects created via
 *   PUT Object with SSE-S3 (AES256) encryption.
 *
 * - Multi-part (buffer.byteLength > partSize): the undocumented but stable
 *   composite format  md5(concat(md5_raw(part1) … md5_raw(partN)))-N
 *   that S3 returns for objects created via the Multipart Upload API.
 */
function awsS3Etag(buffer: ArrayBuffer, partSize: number): string {
  if (buffer.byteLength <= partSize) {
    return md5Hex(buffer)
  }
  return multipartMd5(buffer, partSize)
}

/**
 * Reproduce the S3 multipart ETag for a buffer given a known part size.
 *
 * Algorithm (empirically stable since ~2006, undocumented by AWS):
 *   1. Split buffer into ceil(size / partSize) chunks
 *   2. Compute raw MD5 (16 bytes) of each chunk
 *   3. Concatenate all raw digests
 *   4. Compute MD5 of the concatenation → hex
 *   5. Append "-" + number of parts
 */
function multipartMd5(buffer: ArrayBuffer, partSize: number): string {
  const totalSize = buffer.byteLength
  const partCount = Math.ceil(totalSize / partSize)
  const rawDigests = new Uint8Array(partCount * 16)

  for (let i = 0; i < partCount; i++) {
    const start = i * partSize
    const end = Math.min(start + partSize, totalSize)
    const raw = md5(new Uint8Array(buffer, start, end - start))
    rawDigests.set(raw, i * 16)
  }

  return `${bytesToHex(md5(rawDigests))}-${partCount}`
}

// helper: compute crc32 hex (use js-crc). Accepts ArrayBuffer and returns
// lowercase, zero-padded 8-character hex string.
// Accept ArrayBuffer, Uint8Array or Node Buffer and always compute the CRC32
// over a copied Uint8Array to avoid accidental mutations affecting the
// previously-computed preMappedHash (some consumers may reuse or mutate
// buffers exposed by libraries).
function crc32Hex(input: ArrayBuffer | Uint8Array | Buffer) {
  let bytes: Uint8Array
  // Normalize and copy to ensure immutability
  if (input instanceof Uint8Array) {
    bytes = new Uint8Array(input) // copy
  } else if (
    typeof ArrayBuffer !== 'undefined' &&
    input instanceof ArrayBuffer
  ) {
    bytes = new Uint8Array(input.slice(0)) // copy
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input as any)) {
    // Node Buffer -> copy
    bytes = new Uint8Array(Buffer.from(input as any))
  } else {
    // Fallback: try to coerce
    bytes = new Uint8Array(input as any)
  }

  const raw = crc32fn(bytes as any)
  let num: number
  if (typeof raw === 'number') {
    num = raw >>> 0
  } else {
    num = parseInt(String(raw), 16) >>> 0
    if (!Number.isFinite(num)) num = 0
  }
  return num.toString(16).padStart(8, '0')
}

// crc32 function using js-crc
const crc32fn = createModel({
  width: 32,
  poly: 0x04c11db7,
  init: 0xffffffff,
  refin: true,
  refout: true,
  xorout: 0xffffffff,
})

// helper: compute crc64 hex (use js-crc if available). Returns lowercase,
// zero-padded 16-character hex string. Accepts ArrayBuffer/Uint8Array/Buffer.
function crc64Hex(input: ArrayBuffer | Uint8Array | Buffer) {
  let bytes: Uint8Array
  if (input instanceof Uint8Array) {
    bytes = new Uint8Array(input)
  } else if (
    typeof ArrayBuffer !== 'undefined' &&
    input instanceof ArrayBuffer
  ) {
    bytes = new Uint8Array(input.slice(0))
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input as any)) {
    bytes = new Uint8Array(Buffer.from(input as any))
  } else {
    bytes = new Uint8Array(input as any)
  }

  // NVME model params: width=64, poly=0xAD93D23594C93659, init=0xFFFFFFFFFFFFFFFF, refin=true, refout=true, xorout=0xFFFFFFFFFFFFFFFF
  const crc64nvme = createModel({
    width: 64,
    poly: [0xad93d235, 0x94c93659], // 0xAD93D23594C93659
    init: [0xffffffff, 0xffffffff],
    refin: true,
    refout: true,
    xorout: [0xffffffff, 0xffffffff],
  })

  // js-crc returns a hex string, which is what we want.
  return crc64nvme(bytes)
}
