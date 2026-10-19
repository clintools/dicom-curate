// A browser fires a plain Event, with no message, only when the worker script
// fails to fetch or parse; runtime errors arrive as an ErrorEvent with one.
export function describeWorkerError(event: unknown): string {
  const message = (event as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message !== '') return message
  return `Worker script failed to load or parse. Under Vite below 8, add optimizeDeps.exclude: ['dicom-curate']; see README "Bundlers".`
}
