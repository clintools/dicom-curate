/**
 * HTTP header resolution helpers for dynamic header providers.
 *
 * Extracted from index.ts to avoid circular dependencies between
 * index.ts and mappingWorkerPool.ts.
 */

import type { TFileInfo, TOutputTarget } from './types'

// If the TFileInfo represents an HTTP resource with dynamic headers,
// resolve the headers by calling the provider function.
export async function getHttpInputHeaders(
  fileInfo: TFileInfo,
): Promise<TFileInfo> {
  if (fileInfo.kind === 'http' && typeof fileInfo.headers === 'function') {
    const clonedFileInfo: TFileInfo = { ...fileInfo }
    clonedFileInfo.headers = await fileInfo.headers()
    return clonedFileInfo
  }

  return fileInfo
}

// If the outputTarget includes HTTP with dynamic headers,
// resolve the headers by calling the provider function.
export async function getHttpOutputHeaders(
  outputTarget: TOutputTarget | undefined,
): Promise<TOutputTarget | undefined> {
  if (outputTarget?.http && typeof outputTarget.http.headers === 'function') {
    const clonedOutputTarget: TOutputTarget = {
      ...outputTarget,
    }
    clonedOutputTarget.http = {
      ...outputTarget.http,
      headers: await outputTarget.http.headers(),
    }
    return clonedOutputTarget
  }

  return outputTarget
}
