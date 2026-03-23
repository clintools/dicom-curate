import { jest } from '@jest/globals'
import { fetchWithRetry } from './fetchWithRetry'

describe('fetchWithRetry', () => {
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>

  beforeEach(() => {
    jest.useFakeTimers()
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok', { status: 200 }))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('succeeds on first attempt without retrying', async () => {
    const resp = await fetchWithRetry('https://example.com', { method: 'PUT' })
    expect(resp.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries on TypeError then succeeds', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const resultPromise = fetchWithRetry('https://example.com')

    // First attempt fails, backoff 1000ms
    await jest.advanceTimersByTimeAsync(1000)

    const resp = await resultPromise
    expect(resp.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries multiple times then succeeds', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const resultPromise = fetchWithRetry('https://example.com')

    await jest.advanceTimersByTimeAsync(1000) // attempt 1 backoff
    await jest.advanceTimersByTimeAsync(3000) // attempt 2 backoff
    await jest.advanceTimersByTimeAsync(9000) // attempt 3 backoff

    const resp = await resultPromise
    expect(resp.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('exhausts all 5 attempts and throws', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))

    const resultPromise = fetchWithRetry('https://example.com')

    // Attach the rejection handler before advancing timers to avoid
    // unhandled rejection warnings.
    const assertion = expect(resultPromise).rejects.toThrow('Failed to fetch')

    // Advance through all 4 backoff delays (attempts 1-4 fail and wait)
    await jest.advanceTimersByTimeAsync(1000) // after attempt 1
    await jest.advanceTimersByTimeAsync(3000) // after attempt 2
    await jest.advanceTimersByTimeAsync(9000) // after attempt 3
    await jest.advanceTimersByTimeAsync(27000) // after attempt 4

    // Attempt 5 fails and throws
    await assertion
    expect(fetchSpy).toHaveBeenCalledTimes(5)
  })

  it('does not retry on non-TypeError errors', async () => {
    const error = new DOMException('The operation was aborted', 'AbortError')
    fetchSpy.mockRejectedValueOnce(error)

    await expect(fetchWithRetry('https://example.com')).rejects.toThrow(
      'The operation was aborted',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry on HTTP error responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Server Error', { status: 500 }),
    )

    const resp = await fetchWithRetry('https://example.com')
    expect(resp.status).toBe(500)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('applies exponential backoff timing', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const resultPromise = fetchWithRetry('https://example.com')

    // First attempt fails immediately, then waits 1000ms
    await jest.advanceTimersByTimeAsync(999)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // still waiting

    await jest.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // second attempt fires

    // Second attempt fails, then waits 3000ms
    await jest.advanceTimersByTimeAsync(2999)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // still waiting

    await jest.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3) // third attempt fires

    const resp = await resultPromise
    expect(resp.status).toBe(200)
  })

  it('passes through request arguments to fetch', async () => {
    const init = {
      method: 'PUT' as const,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'test-body',
    }

    await fetchWithRetry('https://example.com/upload', init)

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/upload', init)
  })
})
