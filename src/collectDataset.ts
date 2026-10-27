import type { TCollectedDataset } from './types'

// Binary VRs are excluded from collected datasets: pixel/bulk data belongs to the file
// itself, not to a metadata catalog, and inlining it would blow up structured-clone and
// storage costs (a single oversized private element can be many MB).
const BINARY_VRS = new Set(['OB', 'OW', 'OD', 'OF', 'OL', 'OV', 'UN'])

/**
 * Reduce a parsed dcmjs dict to a plain-JSON, hex-tag-keyed header suitable for
 * postMessage/structured clone and for JSON storage (metadata catalogs, worklists).
 *
 * - binary VRs are dropped entirely (see BINARY_VRS)
 * - element values are round-tripped through JSON with a replacer that drops any
 *   nested ArrayBuffer/TypedArray that survives the VR filter inside sequences,
 *   and strips dcmjs class instances (PN wrappers, raw-value holders) to plain data
 */
export function extractDataset(dict: {
  [tag: string]: { vr?: string; Value?: unknown }
}): TCollectedDataset {
  const out: TCollectedDataset = {}
  for (const tag in dict) {
    const element = dict[tag]
    if (!element || !element.vr || BINARY_VRS.has(element.vr)) {
      continue
    }
    try {
      out[tag] = JSON.parse(
        JSON.stringify({ vr: element.vr, Value: element.Value }, (_key, value) =>
          value instanceof ArrayBuffer || ArrayBuffer.isView(value)
            ? undefined
            : value,
        ),
      )
    } catch {
      // non-serializable element (circular/exotic) — omit rather than fail the file
    }
  }
  return out
}
