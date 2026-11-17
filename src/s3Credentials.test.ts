import {
  createS3CredentialResolver,
  resolveS3InputFileInfo,
  resolveS3OutputTarget,
} from './s3Credentials'
import type { TFileInfo, TS3BucketOptions, TS3Credentials } from './types'

const KEY: TS3Credentials = { accessKeyId: 'KEY', secretAccessKey: 'secret' }
const MINUTE = 60 * 1000
const far = () => new Date(Date.now() + 60 * MINUTE)

function bucketWith(
  credentials: TS3BucketOptions['credentials'],
): TS3BucketOptions {
  return { bucketName: 'bucket', region: 'us-east-1', credentials }
}

describe('createS3CredentialResolver', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('type-checks a static object carrying a session token and expiration', () => {
    const bucket = {
      bucketName: 'bucket',
      credentials: {
        accessKeyId: 'KEY',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: new Date(),
      },
    } satisfies TS3BucketOptions
    expect(bucket.credentials.sessionToken).toBe('token')
  })

  it('returns undefined when the bucket has no credentials', async () => {
    expect(await createS3CredentialResolver(bucketWith(undefined))()).toBe(
      undefined,
    )
  })

  it('re-reads a static object on every call, so in-place changes take effect', async () => {
    const credentials = { ...KEY }
    const bucket = bucketWith(credentials)
    const resolve = createS3CredentialResolver(bucket)

    expect(await resolve()).toEqual(KEY)
    credentials.accessKeyId = 'NEW'
    expect(await resolve()).toEqual({ ...KEY, accessKeyId: 'NEW' })
    bucket.credentials = { ...KEY, accessKeyId: 'REPLACED' }
    expect(await resolve()).toEqual({ ...KEY, accessKeyId: 'REPLACED' })
  })

  it('calls a provider once while its credentials are far from expiry', async () => {
    const provider = vi.fn(() => ({
      ...KEY,
      expiration: far(),
    }))
    const resolve = createS3CredentialResolver(bucketWith(provider))

    for (let i = 0; i < 10; i++) await resolve()

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('calls the provider again once inside 5 minutes of expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const provider = vi.fn(() => ({
      ...KEY,
      expiration: new Date(Date.now() + 10 * MINUTE),
    }))
    const resolve = createS3CredentialResolver(bucketWith(provider))

    await resolve()
    vi.setSystemTime(Date.now() + 4 * MINUTE)
    await resolve()
    expect(provider).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 2 * MINUTE)
    await resolve()
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('calls a provider on every request when its credentials carry no expiration', async () => {
    const provider = vi.fn(async () => KEY)
    const resolve = createS3CredentialResolver(bucketWith(provider))

    for (let i = 0; i < 3; i++) await resolve()

    expect(provider).toHaveBeenCalledTimes(3)
  })

  it('shares one provider call between concurrent requests', async () => {
    let release!: (c: TS3Credentials) => void
    const provider = vi.fn(
      () => new Promise<TS3Credentials>((r) => (release = r)),
    )
    const resolve = createS3CredentialResolver(bucketWith(provider))

    const pending = [resolve(), resolve(), resolve()]
    await vi.waitFor(() => expect(provider).toHaveBeenCalled())
    release(KEY)

    expect(await Promise.all(pending)).toEqual([KEY, KEY, KEY])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('propagates a rejection, including a synchronous throw, and retries next time', async () => {
    let calls = 0
    const provider = vi.fn(() => {
      calls += 1
      if (calls === 1) throw new Error('credential source unavailable')
      return KEY
    })
    const resolve = createS3CredentialResolver(bucketWith(provider))

    await expect(resolve()).rejects.toThrow('credential source unavailable')
    expect(await resolve()).toEqual(KEY)
  })

  it('caches an expiration given as an ISO string', async () => {
    const provider = vi.fn(
      () =>
        ({
          ...KEY,
          expiration: far().toISOString(),
        }) as unknown as TS3Credentials,
    )
    const resolve = createS3CredentialResolver(bucketWith(provider))

    await resolve()
    const credentials = await resolve()

    expect(provider).toHaveBeenCalledTimes(1)
    expect(credentials?.expiration).toBeInstanceOf(Date)
  })

  it('turns a static ISO-string expiration into a Date for the SDK', async () => {
    const expiration = far()
    const resolve = createS3CredentialResolver(
      bucketWith({
        ...KEY,
        expiration: expiration.toISOString(),
      } as unknown as TS3Credentials),
    )

    expect((await resolve())?.expiration).toEqual(expiration)
  })

  it('keeps the current provider cached when a replaced one resolves late', async () => {
    let releaseOld!: (c: TS3Credentials) => void
    const bucket = bucketWith(
      () => new Promise<TS3Credentials>((r) => (releaseOld = r)),
    )
    const resolve = createS3CredentialResolver(bucket)
    const old = resolve()
    await vi.waitFor(() => expect(releaseOld).toBeDefined())

    const current = vi.fn(() => ({ ...KEY, expiration: far() }))
    bucket.credentials = current
    await resolve()
    releaseOld({ ...KEY, accessKeyId: 'OLD', expiration: far() })
    await old
    await resolve()

    expect(current).toHaveBeenCalledTimes(1)
  })

  it('calls again after a provider that resolved nothing', async () => {
    const provider = vi.fn(() => undefined as unknown as TS3Credentials)
    const resolve = createS3CredentialResolver(bucketWith(provider))

    await resolve()
    await expect(resolve()).resolves.toBeUndefined()

    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('does not hand a pending call from a replaced provider to later callers', async () => {
    const bucket = bucketWith(() => new Promise<TS3Credentials>(() => {}))
    const resolve = createS3CredentialResolver(bucket)
    void resolve()

    bucket.credentials = () => ({ ...KEY, accessKeyId: 'NEW' })

    expect((await resolve())?.accessKeyId).toBe('NEW')
  })

  it('drops the cache when the provider itself is replaced', async () => {
    const bucket = bucketWith(() => ({ ...KEY, expiration: far() }))
    const resolve = createS3CredentialResolver(bucket)
    await resolve()

    bucket.credentials = () => ({
      ...KEY,
      accessKeyId: 'NEW',
      expiration: far(),
    })

    expect((await resolve())?.accessKeyId).toBe('NEW')
  })
})

describe('resolveS3InputFileInfo', () => {
  const s3File: TFileInfo = {
    kind: 's3',
    objectKey: 'study/a.dcm',
    name: 'study/a.dcm',
    path: 'study/a.dcm',
    size: 5000,
  }

  it('takes the bucket options from the run input, with resolved credentials', async () => {
    const bucket = bucketWith(() => KEY)

    const resolved = await resolveS3InputFileInfo(s3File, {
      bucket,
      resolve: createS3CredentialResolver(bucket),
    })

    expect(resolved).toEqual({
      ...s3File,
      bucketOptions: { ...bucket, credentials: KEY },
    })
  })

  it('leaves a file that is not on S3 untouched', async () => {
    const blobFile: TFileInfo = {
      kind: 'blob',
      blob: new Blob([]),
      name: 'a.dcm',
      path: '',
      size: 0,
    }
    const bucket = bucketWith(KEY)

    expect(
      await resolveS3InputFileInfo(blobFile, {
        bucket,
        resolve: createS3CredentialResolver(bucket),
      }),
    ).toBe(blobFile)
  })
})

describe('resolveS3OutputTarget', () => {
  it('replaces the output credentials with resolved ones', async () => {
    const s3 = bucketWith(() => KEY)

    const resolved = await resolveS3OutputTarget(
      { s3 },
      createS3CredentialResolver(s3),
    )

    expect(resolved).toEqual({ s3: { ...s3, credentials: KEY } })
  })

  it('leaves a target without S3 untouched', async () => {
    const target = { directory: '/out' }

    expect(
      await resolveS3OutputTarget(
        target,
        createS3CredentialResolver(bucketWith(KEY)),
      ),
    ).toBe(target)
  })
})
