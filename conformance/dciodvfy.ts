import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CONFORMANCE_ALLOWLIST } from './allowlist'

export type DciodvfySeverity = 'Error' | 'Warning'

export type DciodvfyViolation = {
  severity: DciodvfySeverity
  /** Full `dciodvfy -new` line (may include a filesystem path segment). */
  rawLine: string
}

/** DICOM element path segment, e.g. `</StudyDate(0008,0020)>`. */
const TAG_PATH_RE = /^<\/?[^>]*\([0-9A-Fa-f]{4},[0-9A-Fa-f]{4}\)/

function isTagPathSegment(segment: string): boolean {
  return TAG_PATH_RE.test(segment)
}

/**
 * Parse dciodvfy `-new` lines:
 *   Error|Warning - [<filesystem path> -] <tag path> - <message> [- <value>]
 *
 * Lines that do not match `Error|Warning - …` are omitted (not counted as violations).
 */
export function parseDciodvfyOutput(
  stdout: string,
  stderr: string,
): DciodvfyViolation[] {
  const text = `${stdout}\n${stderr}`
  const out: DciodvfyViolation[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const m = /^(Error|Warning)\s*-\s*(.+)$/.exec(t)
    if (m) {
      out.push({
        severity: m[1] as DciodvfySeverity,
        rawLine: t,
      })
    }
  }
  return out
}

/**
 * Normalise for set comparison: `severity::tagPath::message`
 * Drops filesystem paths and collapses per-character UI invalid-value noise.
 *
 * Splits on the literal ` - ` separator; tag paths or messages containing that
 * substring may be parsed incorrectly.
 */
export function normaliseViolation(v: DciodvfyViolation): string {
  const parts = v.rawLine.split(' - ').map((s) => s.trim())
  if (parts.length < 3 || (parts[0] !== 'Error' && parts[0] !== 'Warning')) {
    return v.rawLine
  }

  const severity = parts[0]
  let idx = 1
  if (parts[idx] && !isTagPathSegment(parts[idx])) {
    idx += 1
  }

  const tagPath = parts[idx]
  if (!tagPath || !isTagPathSegment(tagPath)) {
    return `${severity}::${parts.slice(idx).join(' - ')}`
  }

  let message = parts.slice(idx + 1).join(' - ')
  if (message.includes('Character invalid for this VR')) {
    const base = message.split(' - Character invalid for this VR')[0] ?? message
    if (base.startsWith('Value invalid for this VR [UI]')) {
      message = 'Value invalid for this VR [UI]'
    } else {
      message = base
    }
  }

  return `${severity}::${tagPath}::${message}`
}

export function resolveDciodvfyBinary(): string | undefined {
  const fromEnv = process.env.DCIODVFY_PATH?.trim()
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv
    console.warn(
      `[conformance] DCIODVFY_PATH is set but not found (${fromEnv}); falling back to PATH`,
    )
  }
  const r = spawnSync('which', ['dciodvfy'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  return undefined
}

export function runDciodvfy(
  dicomPath: string,
  binary: string,
): DciodvfyViolation[] {
  const r = spawnSync(binary, ['-new', dicomPath], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  })
  if (r.error) {
    throw new Error(`dciodvfy failed to start: ${r.error.message}`)
  }
  if (r.status !== 0 && r.status !== 1) {
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 500)
    throw new Error(
      `dciodvfy exited with status ${r.status}${detail ? `: ${detail}` : ''}`,
    )
  }
  return parseDciodvfyOutput(r.stdout ?? '', r.stderr ?? '')
}

export function violationSet(
  violations: DciodvfyViolation[],
  allowlist: RegExp[] = CONFORMANCE_ALLOWLIST,
): Set<string> {
  const s = new Set<string>()
  for (const v of violations) {
    const n = normaliseViolation(v)
    if (allowlist.some((re) => re.test(n))) continue
    s.add(n)
  }
  return s
}

/** True if `after !== before` as sets of normalised violations. */
export function isConformanceNonRegression(
  before: DciodvfyViolation[],
  after: DciodvfyViolation[],
  allowlist: RegExp[] = CONFORMANCE_ALLOWLIST,
): { ok: boolean; introduced: string[] } {
  const b = violationSet(before, allowlist)
  const a = violationSet(after, allowlist)
  const introduced: string[] = []
  for (const x of a) {
    if (!b.has(x)) introduced.push(x)
  }
  return { ok: introduced.length === 0, introduced }
}
