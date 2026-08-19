/**
 * Resolve after `ms` milliseconds.
 *
 * Both callers run under fake timers in their tests, so this must stay a bare
 * setTimeout with no ambient clock reads.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
