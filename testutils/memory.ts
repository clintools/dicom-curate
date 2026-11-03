/**
 * Scale assertions are rates (bytes per file, slope against input size), not
 * absolute ceilings, so they survive Node upgrades and a slower runner.
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

/**
 * `gc()` without launching with `--expose-gc`: no `NODE_OPTIONS` in package
 * scripts (not portable to Windows shells) and no bespoke pool config.
 */
const exposedGc = (() => {
  setFlagsFromString('--expose-gc')
  // `globalThis.gc`, not bare `gc`: a bare miss throws at import, before
  // forceGc's guard.
  const gc = runInNewContext('globalThis.gc') as (() => void) | undefined
  setFlagsFromString('--no-expose-gc')
  return gc
})()

/** Twice: finalisers run by the first pass can leave newly unreachable objects. */
function forceGc(): void {
  if (!exposedGc) {
    throw new Error(
      'could not expose gc() — scale memory assertions need a V8 with --expose-gc available',
    )
  }
  exposedGc()
  exposedGc()
}

/**
 * Heap still referenced after `run`, in bytes, including anything reachable from
 * its resolved value.
 */
export async function measureRetainedHeap<T>(
  run: () => Promise<T>,
): Promise<{ value: T; retainedBytes: number }> {
  forceGc()
  const before = process.memoryUsage().heapUsed
  const value = await run()
  forceGc()
  const after = process.memoryUsage().heapUsed
  return { value, retainedBytes: after - before }
}

const RSS_SAMPLE_INTERVAL_MS = 10

/**
 * Peak RSS during `run` above its starting level. RSS because a Buffer lands in
 * external memory, invisible to heap figures. Timer-sampled, so a floor on the
 * true peak — enough to show something did not grow.
 */
export async function measurePeakRssOverhead<T>(
  run: () => Promise<T>,
): Promise<{ value: T; peakOverheadBytes: number }> {
  forceGc()
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, RSS_SAMPLE_INTERVAL_MS)
  try {
    const value = await run()
    // A run shorter than one interval would otherwise never be sampled.
    peak = Math.max(peak, process.memoryUsage().rss)
    return { value, peakOverheadBytes: peak - baseline }
  } finally {
    clearInterval(sampler)
  }
}

export const MIB = 1024 * 1024

export function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`
}
