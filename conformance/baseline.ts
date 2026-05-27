import { readFileSync } from 'node:fs'
import type { DciodvfyViolation } from './dciodvfy'
import { violationSet } from './dciodvfy'

export type ConformanceBaseline = {
  /** Human label (fixture filename or public case id). */
  label: string
  /** Sorted normalised violation strings from `dciodvfy -new` on the source file. */
  violations: string[]
  /** Optional note (e.g. dicom3tools version when baseline was captured). */
  notes?: string
}

export function loadConformanceBaseline(path: string): ConformanceBaseline {
  return JSON.parse(readFileSync(path, 'utf8')) as ConformanceBaseline
}

export function baselineViolationSet(path: string): Set<string> {
  const { violations } = loadConformanceBaseline(path)
  return new Set(violations)
}

/** Fail when live `dciodvfy` output drifts from the committed baseline. */
export function baselineDrift(
  baseline: Set<string>,
  live: DciodvfyViolation[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const liveSet = violationSet(live)
  const missing = [...baseline].filter((x) => !liveSet.has(x))
  const extra = [...liveSet].filter((x) => !baseline.has(x))
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}

/** True when no normalised violation in `after` is absent from `baseline`. */
export function noViolationsIntroducedVsBaseline(
  baseline: Set<string>,
  after: DciodvfyViolation[],
): { ok: boolean; introduced: string[] } {
  const afterSet = violationSet(after)
  const introduced: string[] = []
  for (const x of afterSet) {
    if (!baseline.has(x)) introduced.push(x)
  }
  return { ok: introduced.length === 0, introduced }
}
