import { createHash } from 'node:crypto'
import { hash } from './hash'

function textBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}

describe('hash', () => {
  const hello = textBuffer('hello')

  it('computes md5 hex matching node crypto', async () => {
    const expected = createHash('md5').update(Buffer.from(hello)).digest('hex')

    expect(await hash(hello, 'md5')).toBe(expected)
  })

  it('defaults unknown methods to md5', async () => {
    expect(await hash(hello, 'not-a-method' as 'md5')).toBe(
      await hash(hello, 'md5'),
    )
  })

  it('computes sha256 hex matching node crypto', async () => {
    const expected = createHash('sha256')
      .update(Buffer.from(hello))
      .digest('hex')

    expect(await hash(hello, 'sha256')).toBe(expected)
  })

  it('computes crc32 as an 8-character lowercase hex string', async () => {
    const digest = await hash(hello, 'crc32')

    expect(digest).toMatch(/^[0-9a-f]{8}$/)
    expect(digest).toBe(await hash(hello, 'crc32'))
  })

  it('computes crc64 as a stable 16-character lowercase hex string', async () => {
    const digest = await hash(hello, 'crc64')

    expect(digest).toMatch(/^[0-9a-f]{16}$/)
    expect(digest).toBe('3377857006524257')
    expect(digest).toBe(await hash(hello, 'crc64'))
  })

  it('uses plain md5 for aws-s3-etag when the buffer fits in one part', async () => {
    const small = textBuffer('x')
    const partSize = 1024

    expect(await hash(small, 'aws-s3-etag-2025', partSize)).toBe(
      await hash(small, 'md5'),
    )
  })

  it('uses plain md5 for aws-s3-etag when byteLength equals part size', async () => {
    const partSize = 3
    const exact = new Uint8Array(partSize)
    exact.fill(0xab)

    expect(await hash(exact.buffer, 'aws-s3-etag-2025', partSize)).toBe(
      await hash(exact.buffer, 'md5'),
    )
    expect(await hash(exact.buffer, 'aws-s3-etag-2025', partSize)).not.toMatch(
      /-\d+$/,
    )
  })

  it('uses composite multipart etag when the buffer exceeds part size', async () => {
    const data = new Uint8Array(10)
    data.fill(0xab)
    const partSize = 3

    const etag = await hash(data.buffer, 'aws-s3-etag-2025', partSize)
    const plainMd5 = await hash(data.buffer, 'md5')

    expect(etag).toMatch(/^[0-9a-f]{32}-4$/)
    expect(etag).not.toBe(plainMd5)
    expect(etag).toBe(await hash(data.buffer, 'aws-s3-etag-2025', partSize))
  })

  it('produces the same crc32 for separate ArrayBuffers with identical bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const copy = new Uint8Array(bytes).buffer

    expect(await hash(bytes.buffer, 'crc32')).toBe(await hash(copy, 'crc32'))
  })
})
