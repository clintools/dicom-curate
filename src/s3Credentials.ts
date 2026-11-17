/**
 * S3 credential resolution on the main thread. Providers are functions and
 * cannot be structured-cloned, so every worker message carries resolved
 * credentials only.
 */

import type {
  TFileInfo,
  TOutputTarget,
  TS3BucketOptions,
  TS3Credentials,
} from './types'

// Provider credentials are refreshed this long before they expire, so no
// request is signed with credentials about to lapse.
const REFRESH_WINDOW_MS = 5 * 60 * 1000

export type TS3CredentialResolver = () => Promise<TS3Credentials | undefined>

export type TS3InputSource = {
  bucket: TS3BucketOptions
  resolve: TS3CredentialResolver
}

// A copy, with `expiration` as a Date: the SDK's expiry check calls
// getTime(), so an ISO string from an untyped JS caller would throw there.
function normaliseCredentials(credentials: TS3Credentials): TS3Credentials {
  return (
    credentials && {
      ...credentials,
      ...(credentials.expiration && {
        expiration: new Date(credentials.expiration),
      }),
    }
  )
}

/**
 * Reads `bucket.credentials` on every call, so a static object changed in place
 * takes effect at the next request. Provider results are cached only when they
 * carry an `expiration`; concurrent callers share one in-flight call.
 */
export function createS3CredentialResolver(
  bucket: TS3BucketOptions,
): TS3CredentialResolver {
  let cached: { source: unknown; credentials: TS3Credentials } | undefined
  let inFlight:
    | { source: unknown; promise: Promise<TS3Credentials> }
    | undefined

  return async () => {
    const source = bucket.credentials
    if (typeof source !== 'function') {
      return source && normaliseCredentials(source)
    }

    // Optional chaining tolerates an untyped JS provider that resolves nothing.
    const expiration = cached?.credentials?.expiration
    if (
      cached?.source === source &&
      expiration &&
      expiration.getTime() - Date.now() > REFRESH_WINDOW_MS
    ) {
      return cached.credentials
    }

    // Keyed by source: a caller after a provider swap must not get the old
    // provider's result.
    if (inFlight?.source !== source) {
      // Promise.resolve().then() turns a synchronous throw into a rejection.
      const promise = Promise.resolve()
        .then(source)
        .then((result) => {
          const credentials = normaliseCredentials(result)
          // A replaced provider's late result must not evict the current one.
          if (bucket.credentials === source) cached = { source, credentials }
          return credentials
        })
        .finally(() => {
          if (inFlight?.promise === promise) inFlight = undefined
        })
      inFlight = { source, promise }
    }
    return inFlight.promise
  }
}

// Bucket options come from the run's input, not the file: the scan queues S3
// files without them.
export async function resolveS3InputFileInfo(
  fileInfo: TFileInfo,
  input: TS3InputSource | undefined,
): Promise<TFileInfo> {
  if (fileInfo.kind !== 's3' || !input) return fileInfo
  return {
    ...fileInfo,
    bucketOptions: { ...input.bucket, credentials: await input.resolve() },
  }
}

export async function resolveS3OutputTarget(
  outputTarget: TOutputTarget | undefined,
  resolve: TS3CredentialResolver | undefined,
): Promise<TOutputTarget | undefined> {
  if (!outputTarget?.s3 || !resolve) return outputTarget
  return {
    ...outputTarget,
    s3: { ...outputTarget.s3, credentials: await resolve() },
  }
}
