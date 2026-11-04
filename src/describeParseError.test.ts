import { describeParseError } from './describeParseError'

describe('describeParseError', () => {
  it('keeps the message of an Error', () => {
    expect(describeParseError(new Error('bad tag'))).toBe('bad tag')
  })

  it('names a message-less Error and where it was thrown', () => {
    expect(describeParseError(new Error())).toMatch(
      /^Error with no message, at /,
    )
  })

  it('names a message-less Error that has no stack', () => {
    const error = new TypeError()
    error.stack = undefined
    expect(describeParseError(error)).toBe('TypeError with no message')
  })

  it('falls back to "Error" when the name is empty too', () => {
    const error = new Error()
    error.name = ''
    error.stack = ''
    expect(describeParseError(error)).toBe('Error with no message')
  })

  it.each([
    ['a non-empty string', 'network error', 'network error'],
    ['an empty string', '', 'Unknown parse error'],
    ['undefined', undefined, 'undefined'],
    ['an object without toString', Object.create(null), 'Unknown parse error'],
  ])('describes %s', (_label, thrown, expected) => {
    expect(describeParseError(thrown)).toBe(expected)
  })
})
