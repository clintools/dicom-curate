/**
 * Wraps fetch() with retry logic for transient network errors.
 *
 * Retries only on TypeError (network failure — request never reached the
 * server). Does NOT retry on HTTP error responses (4xx, 5xx) since those
 * indicate the request was received and a retry without changing the request
 * would likely produce the same result.
 *
 * Uses exponential backoff (1s, 3s, 9s, 27s, 81s) which also acts as natural
 * backpressure — workers block during backoff, reducing concurrent uploads.
 */

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000
const BACKOFF_MULTIPLIER = 3

export async function fetchWithRetry(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(...args)
    } catch (error) {
      const isNetworkError = error instanceof TypeError
      const isLastAttempt = attempt === MAX_ATTEMPTS

      if (!isNetworkError || isLastAttempt) {
        throw error
      }

      const delayMs = BASE_DELAY_MS * BACKOFF_MULTIPLIER ** (attempt - 1)
      console.warn(
        `fetch attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(error as TypeError).message}. Retrying in ${delayMs}ms...`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  // Unreachable — the loop either returns or throws on the last attempt.
  throw new Error('fetchWithRetry: unreachable')
}
