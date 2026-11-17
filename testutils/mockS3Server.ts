/**
 * Local S3 stand-in for credential tests: path-style ListObjectsV2, GetObject
 * and PutObject, recording the access key ID that signed each request.
 *
 * Reached through `endpoint` and `forcePathStyle: true`. Signatures are not
 * verified; only the `Credential=<AKID>/` scope of the SigV4 header is read.
 */
import { createHash } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

export type S3Op = 'list' | 'get' | 'put'

export type S3RequestRecord = {
  op: S3Op
  accessKeyId: string | undefined
  rejected: boolean
}

export type MockS3Server = {
  endpoint: string
  /** Objects per bucket; PutObject creates the bucket on first write. */
  buckets: Map<string, Map<string, Buffer>>
  requests: S3RequestRecord[]
  /** Reject later `op` requests signed with this key. */
  revoke(accessKeyId: string, op: S3Op): void
  /**
   * Called on arrival, before the revocation check, so a test can switch
   * credentials or revoke a key at an exact request.
   */
  onRequest?: (record: S3RequestRecord) => void
  close(): Promise<void>
}

const EXPIRED_TOKEN_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>'

const LAST_MODIFIED = new Date('2026-01-01T00:00:00.000Z')

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function etagOf(body: Buffer): string {
  return `"${createHash('md5').update(body).digest('hex')}"`
}

function accessKeyIdOf(req: IncomingMessage): string | undefined {
  return /Credential=([^/]+)\//.exec(req.headers.authorization ?? '')?.[1]
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function startMockS3Server({
  pageSize = 1000,
}: {
  /** Keys per ListObjectsV2 page, whatever `max-keys` the client sends. */
  pageSize?: number
} = {}): Promise<MockS3Server> {
  const buckets = new Map<string, Map<string, Buffer>>()
  const requests: S3RequestRecord[] = []
  const revoked = new Set<string>()

  function listPage(
    res: ServerResponse,
    bucket: string,
    url: URL,
    objects: Map<string, Buffer>,
  ) {
    const prefix = url.searchParams.get('prefix') ?? ''
    const start = Number(url.searchParams.get('continuation-token') ?? '0')
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const page = keys.slice(start, start + pageSize)
    const next = start + pageSize < keys.length ? start + pageSize : undefined

    const contents = page
      .map((key) => {
        const object = objects.get(key)!
        return `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${LAST_MODIFIED.toISOString()}</LastModified><ETag>${etagOf(object)}</ETag><Size>${object.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`
      })
      .join('')
    const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${next !== undefined}</IsTruncated>${contents}${next !== undefined ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(body)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const [bucket = '', ...keyParts] = url.pathname
      .slice(1)
      .split('/')
      .map(decodeURIComponent)
    const key = keyParts.join('/')
    const op: S3Op = req.method === 'PUT' ? 'put' : key === '' ? 'list' : 'get'
    const accessKeyId = accessKeyIdOf(req)

    const record: S3RequestRecord = { op, accessKeyId, rejected: false }
    requests.push(record)
    server.onRequest?.(record)

    // Drained before any reply so a rejected PutObject cannot stall its socket.
    const body = await readBody(req)

    if (revoked.has(`${accessKeyId}:${op}`)) {
      record.rejected = true
      res.writeHead(400, { 'Content-Type': 'application/xml' })
      res.end(EXPIRED_TOKEN_XML)
      return
    }

    const objects = buckets.get(bucket)
    if (op === 'put') {
      const target = objects ?? new Map<string, Buffer>()
      buckets.set(bucket, target)
      target.set(key, body)
      res.writeHead(200, { ETag: etagOf(body) })
      res.end()
      return
    }
    if (op === 'list') {
      listPage(res, bucket, url, objects ?? new Map())
      return
    }
    const object = objects?.get(key)
    if (!object) {
      res.writeHead(404, { 'Content-Type': 'application/xml' })
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
      )
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': object.length,
      ETag: etagOf(object),
      'Last-Modified': LAST_MODIFIED.toUTCString(),
    })
    res.end(object)
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  )
  const { port } = httpServer.address() as AddressInfo

  const server: MockS3Server = {
    endpoint: `http://127.0.0.1:${port}`,
    buckets,
    requests,
    revoke(accessKeyId, op) {
      revoked.add(`${accessKeyId}:${op}`)
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections()
        httpServer.close((error) => (error ? reject(error) : resolve()))
      }),
  }
  return server
}
