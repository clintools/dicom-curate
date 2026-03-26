// Strange problems can happen when loading the AWS SDK twice,
// so we cache the imported module here
let cachedS3Client: any = null

// Handles dynamic import of AWS S3 SDK, compatible with both ESM and CJS environments
export async function loadS3Client(): Promise<any> {
  if (cachedS3Client) {
    return cachedS3Client
  }
  if (typeof window === 'undefined') {
    // Node-only fallback
    const { createRequire } = await import('module')
    const req = createRequire(import.meta.url)
    const mod = req('@aws-sdk/client-s3')
    cachedS3Client = mod?.default ?? mod
  } else {
    // browser-friendly dynamic import -> code-split chunk
    cachedS3Client = await import('@aws-sdk/client-s3')
  }
  return cachedS3Client
}
