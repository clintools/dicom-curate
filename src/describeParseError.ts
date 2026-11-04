// A parse failure must never be recorded with an empty reason. dcmjs throws
// some failures as `new Error()` with no message (#331); for those the error
// name and the first stack frame identify where the parse stopped.
export function describeParseError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message !== '') return error.message
    const name = error.name || 'Error'
    const frame = error.stack
      ?.split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('at '))
    return frame
      ? `${name} with no message, ${frame}`
      : `${name} with no message`
  }
  let text = ''
  try {
    text = String(error)
  } catch {
    // An object without a usable toString, e.g. Object.create(null).
  }
  return text !== '' ? text : 'Unknown parse error'
}
