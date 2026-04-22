// Strange problems can happen when loading the AWS SDK twice,
// so we cache the imported module here
let cachedLibStorage: any = null

// Handles dynamic import of @aws-sdk/lib-storage, compatible with both
// ESM and CJS environments. Mirrors the loadS3Client pattern so the
// module is only required at runtime on the S3 output path.
export async function loadLibStorage(): Promise<any> {
  if (cachedLibStorage) {
    return cachedLibStorage
  }
  if (typeof window === 'undefined') {
    // Node-only fallback
    const { createRequire } = await import('module')
    const req = createRequire(import.meta.url)
    const mod = req('@aws-sdk/lib-storage')
    cachedLibStorage = mod?.default ?? mod
  } else {
    // browser-friendly dynamic import -> code-split chunk
    cachedLibStorage = await import('@aws-sdk/lib-storage')
  }
  return cachedLibStorage
}
