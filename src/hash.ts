import { THashMethod } from './types'
import md5 from 'md5'
import { createModel } from 'js-crc'

const DEFAULT_HASH_PART_SIZE = 5 * 1024 * 1024 // 5 MB — matches @aws-sdk/lib-storage default

export async function hash(
  buffer: ArrayBuffer,
  hashMethod: THashMethod,
  hashPartSize?: number,
): Promise<string> {
  switch (hashMethod) {
    case 'sha256':
      return await sha256Hex(buffer)
    case 'crc32':
      return crc32Hex(buffer)
    case 'crc64':
      return crc64Hex(buffer)
    case 'aws-s3-etag-2025':
      return awsS3Etag(buffer, hashPartSize ?? DEFAULT_HASH_PART_SIZE)
    case 'md5':
    default:
      return md5Hex(buffer)
  }
}

// helper: compute sha256 hex
async function sha256Hex(buffer: ArrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function md5Hex(buffer: ArrayBuffer) {
  return md5(new Uint8Array(buffer))
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
    const partBuffer = buffer.slice(start, end)
    // md5() returns a 32-char hex string; convert to 16 raw bytes
    const hex = md5(new Uint8Array(partBuffer))
    for (let j = 0; j < 16; j++) {
      rawDigests[i * 16 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16)
    }
  }

  return `${md5(rawDigests)}-${partCount}`
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
