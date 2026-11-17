/**
 * S3 credentials current at each request (#336), against real workers and a
 * local S3 stand-in that rejects a revoked key with `ExpiredToken`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
  integrationSpec,
  listFilesRecursive,
  runCapturingProgress,
  runExpectingRejection,
  useWorkspaces,
  writeImages,
} from '../testutils/integrationHarness'
import {
  type MockS3Server,
  type S3Op,
  startMockS3Server,
} from '../testutils/mockS3Server'
import type {
  OrganizeOptions,
  TMapResults,
  TS3BucketOptions,
  TS3Credentials,
} from './types'

const INPUT_BUCKET = 'input-bucket'
const OUTPUT_BUCKET = 'output-bucket'
const SECRET = 'secret'

// Files dispatched with OLD just before the switch still send their GET; this
// many further GETs let those land before OLD is revoked. Each worker sends its
// GET before it can take another file, so 3 per worker is ample.
const REVOKE_GRACE_GETS = 12

describe('S3 credentials across a long run (#336)', () => {
  const workspace = useWorkspaces()
  let server: MockS3Server | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function seededServer(
    count: number,
    pageSize?: number,
  ): Promise<{ server: MockS3Server; outputDir: string }> {
    const { inputDir, outputDir } = workspace()
    await writeImages(inputDir, count)
    server = await startMockS3Server({ pageSize })
    // Keys start with `input/` so integrationSpec's inputPathPattern matches.
    const objects = new Map<string, Buffer>()
    for (const rel of listFilesRecursive(inputDir)) {
      objects.set(`input/${rel}`, readFileSync(join(inputDir, rel)))
    }
    server.buckets.set(INPUT_BUCKET, objects)
    return { server, outputDir }
  }

  function bucket(
    s3: MockS3Server,
    bucketName: string,
    credentials: TS3BucketOptions['credentials'],
  ): TS3BucketOptions {
    return {
      bucketName,
      region: 'us-east-1',
      endpoint: s3.endpoint,
      forcePathStyle: true,
      credentials,
    }
  }

  function s3Options(
    s3: MockS3Server,
    credentials: TS3BucketOptions['credentials'],
    outputDir: string,
    overrides?: Partial<OrganizeOptions>,
  ): OrganizeOptions {
    return {
      inputType: 's3',
      inputS3Bucket: bucket(s3, INPUT_BUCKET, credentials),
      outputDirectory: outputDir,
      curationSpec: integrationSpec(),
      workerCount: 4,
      ...overrides,
    } as OrganizeOptions
  }

  /**
   * After `switchAt` requests of `op`, call `onSwitch`; `revokeAfter` requests
   * of `op` later, revoke OLD. Returns the request index of the revocation.
   */
  function switchThenRevoke(
    s3: MockS3Server,
    op: S3Op,
    switchAt: number,
    revokeAfter: number,
    onSwitch: () => void,
  ): { revokedAt: () => number | undefined } {
    let seen = 0
    let revokedAt: number | undefined
    s3.onRequest = (record) => {
      if (record.op !== op) return
      seen += 1
      if (seen === switchAt) onSwitch()
      if (seen === switchAt + revokeAfter) {
        s3.revoke('OLD', op)
        // The request that triggered this is already in the log.
        revokedAt = s3.requests.length - 1
      }
    }
    return { revokedAt: () => revokedAt }
  }

  function errorsOf(results: TMapResults[] | undefined): string[] {
    return (results ?? []).flatMap((r) => [
      ...r.errors,
      ...(r.uploadErrors ?? []),
    ])
  }

  it('reads every file after a static credentials object is changed in place', async () => {
    const count = 40
    const { server: s3, outputDir } = await seededServer(count)
    const credentials: TS3Credentials = {
      accessKeyId: 'OLD',
      secretAccessKey: SECRET,
    }
    switchThenRevoke(s3, 'get', 10, REVOKE_GRACE_GETS, () => {
      credentials.accessKeyId = 'NEW'
    })

    const { result } = await runCapturingProgress(
      s3Options(s3, credentials, outputDir),
    )

    expect(errorsOf(result.mapResultsList)).toEqual([])
    expect(result.processedFiles).toBe(count)
    expect(listFilesRecursive(outputDir)).toHaveLength(count)
    expect(s3.requests.filter((r) => r.rejected)).toEqual([])
  })

  it('reads every file with a provider that switches keys, and stops using the old one', async () => {
    const count = 40
    const { server: s3, outputDir } = await seededServer(count)
    let current = 'OLD'
    const { revokedAt } = switchThenRevoke(
      s3,
      'get',
      10,
      REVOKE_GRACE_GETS,
      () => {
        current = 'NEW'
      },
    )

    const { result } = await runCapturingProgress(
      s3Options(
        s3,
        () => ({ accessKeyId: current, secretAccessKey: SECRET }),
        outputDir,
      ),
    )

    expect(errorsOf(result.mapResultsList)).toEqual([])
    expect(result.processedFiles).toBe(count)
    const afterRevocation = s3.requests.slice(revokedAt())
    expect(afterRevocation.length).toBeGreaterThan(0)
    expect(afterRevocation.every((r) => r.accessKeyId === 'NEW')).toBe(true)
  })

  it('lists every page after the credentials change mid-listing', async () => {
    const count = 40
    const pageSize = 5
    const { server: s3, outputDir } = await seededServer(count, pageSize)
    const credentials: TS3Credentials = {
      accessKeyId: 'OLD',
      secretAccessKey: SECRET,
    }
    // Switch when page 2 is requested and revoke from page 3, so page 3 is the
    // first request that must have asked for credentials after the switch.
    switchThenRevoke(s3, 'list', 2, 1, () => {
      credentials.accessKeyId = 'NEW'
    })

    const { result } = await runCapturingProgress(
      s3Options(s3, credentials, outputDir),
    )

    expect(result.processedFiles).toBe(count)
    const lists = s3.requests.filter((r) => r.op === 'list')
    expect(lists).toHaveLength(count / pageSize)
    expect(lists.slice(2).every((r) => r.accessKeyId === 'NEW')).toBe(true)
    expect(lists.some((r) => r.rejected)).toBe(false)
  })

  it('pauses the listing under backpressure and resumes it with current credentials', async () => {
    // index.ts pauses the scan above 100 queued files.
    const count = 250
    const pageSize = 20
    const workerCount = 1
    const { server: s3, outputDir } = await seededServer(count, pageSize)
    const credentials: TS3Credentials = {
      accessKeyId: 'OLD',
      secretAccessKey: SECRET,
    }
    let listed = 0
    let gets = 0
    let getsSinceList = 0
    let maxOutstanding = 0
    let switchedAt: number | undefined
    s3.onRequest = (record) => {
      if (record.op === 'list') {
        listed = Math.min(listed + pageSize, count)
        getsSinceList = 0
        maxOutstanding = Math.max(maxOutstanding, listed - gets)
        return
      }
      if (record.op !== 'get') return
      gets += 1
      getsSinceList += 1
      // Thirty reads with no listing request mean the feeder is paused, and a
      // paused feeder holds no credentials request, so the next page asks after
      // the switch.
      if (switchedAt === undefined && getsSinceList === 30) {
        credentials.accessKeyId = 'NEW'
        s3.revoke('OLD', 'list')
        switchedAt = s3.requests.length
      }
    }

    const { result } = await runCapturingProgress(
      s3Options(s3, credentials, outputDir, { workerCount }),
    )

    expect(result.processedFiles).toBe(count)
    expect(errorsOf(result.mapResultsList)).toEqual([])
    // Queued, the rest of the page emitted before 'stop' arrives, the next
    // page, and in flight. Unpaused, the whole bucket is listed up front.
    expect(maxOutstanding).toBeLessThanOrEqual(101 + 2 * pageSize + workerCount)
    const listsAfterSwitch = s3.requests
      .slice(switchedAt)
      .filter((r) => r.op === 'list')
    expect(listsAfterSwitch.length).toBeGreaterThan(0)
    expect(listsAfterSwitch.every((r) => r.accessKeyId === 'NEW')).toBe(true)
  })

  it('keeps resolved credentials out of the results of files that fail', async () => {
    const count = 5
    const { server: s3, outputDir } = await seededServer(count)
    const secret = 'secret-that-must-not-leak'
    s3.revoke('KEY', 'get')

    const { result } = await runCapturingProgress(
      s3Options(
        s3,
        () => ({ accessKeyId: 'KEY', secretAccessKey: secret }),
        outputDir,
      ),
    )

    expect(errorsOf(result.mapResultsList)).toHaveLength(count)
    expect(JSON.stringify(result.mapResultsList)).not.toContain(secret)
  })

  it('accepts a provider for both the input and the output bucket', async () => {
    const count = 10
    const { server: s3, outputDir } = await seededServer(count)
    const provider = () => ({ accessKeyId: 'KEY', secretAccessKey: SECRET })

    const { result } = await runCapturingProgress(
      s3Options(s3, provider, outputDir, {
        outputDirectory: undefined,
        outputEndpoint: bucket(s3, OUTPUT_BUCKET, provider),
      }),
    )

    expect(errorsOf(result.mapResultsList)).toEqual([])
    expect(result.processedFiles).toBe(count)
    expect(s3.buckets.get(OUTPUT_BUCKET)?.size).toBe(count)
  })

  it('reuses credentials with a distant expiration instead of calling the provider per file', async () => {
    const count = 40
    const { server: s3, outputDir } = await seededServer(count)
    let calls = 0
    const provider = async () => {
      calls += 1
      return {
        accessKeyId: 'KEY',
        secretAccessKey: SECRET,
        expiration: new Date(Date.now() + 60 * 60 * 1000),
      }
    }

    const { result } = await runCapturingProgress(
      s3Options(s3, provider, outputDir),
    )

    expect(result.processedFiles).toBe(count)
    expect(calls).toBe(1)
  })

  it('calls the provider again when the expiration is inside the refresh window', async () => {
    const count = 20
    const { server: s3, outputDir } = await seededServer(count)
    let calls = 0
    const provider = async () => {
      calls += 1
      return {
        accessKeyId: 'KEY',
        secretAccessKey: SECRET,
        expiration: new Date(Date.now() + 60 * 1000),
      }
    }

    const { result } = await runCapturingProgress(
      s3Options(s3, provider, outputDir),
    )

    expect(result.processedFiles).toBe(count)
    // One per dispatch plus one for the single listing page.
    expect(calls).toBe(count + 1)
  })

  it('rejects the run through the dispatch-failure path when the provider keeps failing', async () => {
    // A single listing page, so the provider fails on dispatch, not listing.
    const { server: s3, outputDir } = await seededServer(60)
    let calls = 0
    const provider = () => {
      calls += 1
      if (calls > 5) throw new Error('credential source unavailable')
      return { accessKeyId: 'KEY', secretAccessKey: SECRET }
    }

    const { error } = await runExpectingRejection(
      s3Options(s3, provider, outputDir, { workerCount: 1 }),
    )

    expect(String(error)).toMatch(
      /Dispatch failed for \d+ consecutive files .*credential source unavailable/,
    )
  })
})
