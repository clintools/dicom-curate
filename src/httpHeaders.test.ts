import { getHttpInputHeaders, getHttpOutputHeaders } from './httpHeaders'
import type { TFileInfo, TOutputTarget } from './types'

describe('getHttpInputHeaders', () => {
  it('returns blob fileInfo unchanged', async () => {
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob(['x']),
      path: 'p',
      name: 'n.dcm',
      size: 1,
    }

    expect(await getHttpInputHeaders(fileInfo)).toBe(fileInfo)
  })

  it('returns http fileInfo unchanged when headers are static', async () => {
    const fileInfo: TFileInfo = {
      kind: 'http',
      url: 'https://example.com/study.dcm',
      headers: { Authorization: 'static' },
      path: '',
      name: 'study.dcm',
      size: 0,
    }

    expect(await getHttpInputHeaders(fileInfo)).toBe(fileInfo)
  })

  it('resolves dynamic http input headers into a clone', async () => {
    const fileInfo: TFileInfo = {
      kind: 'http',
      url: 'https://example.com/study.dcm',
      headers: async () => ({ Authorization: 'Bearer tok' }),
      path: '',
      name: 'study.dcm',
      size: 0,
    }

    const resolved = await getHttpInputHeaders(fileInfo)

    expect(resolved).not.toBe(fileInfo)
    expect(resolved.kind).toBe('http')
    if (resolved.kind !== 'http') throw new Error('expected http file info')
    expect(resolved.headers).toEqual({ Authorization: 'Bearer tok' })
    if (fileInfo.kind !== 'http') throw new Error('expected http file info')
    expect(typeof fileInfo.headers).toBe('function')
  })

  it('supports synchronous header providers', async () => {
    const fileInfo: TFileInfo = {
      kind: 'http',
      url: 'https://example.com/x',
      headers: () => ({ 'X-Custom': 'sync' }),
      path: '',
      name: 'x',
      size: 0,
    }

    const resolved = await getHttpInputHeaders(fileInfo)

    expect(resolved.kind).toBe('http')
    if (resolved.kind !== 'http') throw new Error('expected http file info')
    expect(resolved.headers).toEqual({ 'X-Custom': 'sync' })
  })
})

describe('getHttpOutputHeaders', () => {
  it('returns undefined unchanged', async () => {
    expect(await getHttpOutputHeaders(undefined)).toBeUndefined()
  })

  it('returns directory-only targets unchanged', async () => {
    const outputTarget: TOutputTarget = { directory: '/out' }

    expect(await getHttpOutputHeaders(outputTarget)).toBe(outputTarget)
  })

  it('returns http targets with static headers unchanged', async () => {
    const outputTarget: TOutputTarget = {
      http: {
        url: 'https://example.com/upload/',
        headers: { 'Content-Type': 'application/dicom' },
      },
    }

    expect(await getHttpOutputHeaders(outputTarget)).toBe(outputTarget)
  })

  it('resolves dynamic http output headers into a clone', async () => {
    const outputTarget: TOutputTarget = {
      http: {
        url: 'https://example.com/upload/',
        headers: async () => ({ Authorization: 'Bearer out' }),
      },
    }

    const resolved = await getHttpOutputHeaders(outputTarget)

    expect(resolved).not.toBe(outputTarget)
    expect(resolved?.http?.headers).toEqual({ Authorization: 'Bearer out' })
    expect(typeof outputTarget.http?.headers).toBe('function')
  })
})
