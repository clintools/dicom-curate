import { isS3KeyExcludedByName } from './scanDirectoryWorker'

describe('isS3KeyExcludedByName', () => {
  it('excludes a default-excluded file listed under a prefix', () => {
    // An S3 key carries its prefix; the exclusion list holds bare filenames.
    expect(isS3KeyExcludedByName('study1/series2/DICOMDIR', [], true)).toBe(
      true,
    )
    expect(isS3KeyExcludedByName('DICOMDIR', [], true)).toBe(true)
  })

  it('applies the default exclusions on the S3 path', () => {
    // The defaults must apply to bucket scans, not just caller-supplied entries.
    expect(isS3KeyExcludedByName('a/b/Thumbs.db', [], true)).toBe(true)
    expect(isS3KeyExcludedByName('a/b/.DS_Store', [], true)).toBe(true)
  })

  it('honours noDefaultExclusions by omitting the defaults', () => {
    expect(isS3KeyExcludedByName('study1/DICOMDIR', [], false)).toBe(false)
  })

  it('matches caller-supplied exclusions case-insensitively', () => {
    expect(isS3KeyExcludedByName('a/NOTES.TXT', ['notes.txt'], false)).toBe(
      true,
    )
  })

  it('does not exclude ordinary instances', () => {
    expect(isS3KeyExcludedByName('study1/IM000001.dcm', [], true)).toBe(false)
  })

  it('does not match on a partial filename', () => {
    expect(isS3KeyExcludedByName('a/DICOMDIR.dcm', [], true)).toBe(false)
    expect(isS3KeyExcludedByName('a/NOTDICOMDIR', [], true)).toBe(false)
  })

  it('handles a key with a trailing slash', () => {
    expect(isS3KeyExcludedByName('study1/', [], true)).toBe(false)
  })
})
