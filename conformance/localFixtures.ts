import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from 'node:path'

export type LocalConformanceCase = {
  /** Stable id for baselines (basename or path-relative slug). */
  id: string
  dicomPath: string
  /** Present when `CONFORMANCE_LOCAL_BASELINE_DIR` is set. */
  baselinePath?: string
}

/** Roots from `CONFORMANCE_LOCAL_PATH` (file, directory, or `path.delimiter`-separated list). */
export function parseConformanceLocalPathEnv(): string[] {
  const raw = process.env.CONFORMANCE_LOCAL_PATH?.trim()
  if (!raw) return []
  if (raw.includes(delimiter)) {
    return raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [raw]
}

function walkDicomFiles(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      walkDicomFiles(full, out)
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.dcm')) {
      out.push(full)
    }
  }
}

function fixtureIdForFile(filePath: string, root: string): string {
  const rel = relative(root, filePath)
  if (!rel || rel === basename(filePath)) {
    return basename(filePath).replace(/\.dcm$/i, '')
  }
  return rel.replace(/\.dcm$/i, '').replace(/[/\\]/g, '--')
}

function rootSlug(absRoot: string, isFile: boolean): string {
  if (isFile) {
    return basename(absRoot).replace(/\.dcm$/i, '')
  }
  return basename(absRoot) || 'root'
}

export function localBaselinePath(
  baselineDir: string,
  fixtureId: string,
): string {
  return join(resolve(baselineDir), `${fixtureId}.dciodvfy-baseline.json`)
}

function discoverUnderRoot(
  root: string,
  baselineDir: string | undefined,
  idPrefix: string | undefined,
): LocalConformanceCase[] {
  const absRoot = resolve(root)
  if (!existsSync(absRoot)) {
    throw new Error(`CONFORMANCE_LOCAL_PATH does not exist: ${absRoot}`)
  }
  const st = statSync(absRoot)

  const dicomPaths: { path: string; searchRoot: string }[] = []

  if (st.isFile()) {
    if (!absRoot.toLowerCase().endsWith('.dcm')) {
      throw new Error(`CONFORMANCE_LOCAL_PATH is not a .dcm file: ${absRoot}`)
    }
    dicomPaths.push({ path: absRoot, searchRoot: dirname(absRoot) })
  } else if (st.isDirectory()) {
    const files: string[] = []
    walkDicomFiles(absRoot, files)
    files.sort()
    if (files.length === 0) {
      throw new Error(`No .dcm files under CONFORMANCE_LOCAL_PATH: ${absRoot}`)
    }
    for (const p of files) {
      dicomPaths.push({ path: p, searchRoot: absRoot })
    }
  } else {
    throw new Error(
      `CONFORMANCE_LOCAL_PATH is not a file or directory: ${absRoot}`,
    )
  }

  return dicomPaths.map(({ path, searchRoot }) => {
    let id = fixtureIdForFile(path, searchRoot)
    if (idPrefix) id = `${idPrefix}--${id}`
    return {
      id,
      dicomPath: path,
      baselinePath: baselineDir
        ? localBaselinePath(baselineDir, id)
        : undefined,
    }
  })
}

/** All local cases configured via env; empty when `CONFORMANCE_LOCAL_PATH` is unset. */
export function resolveLocalConformanceCases(): LocalConformanceCase[] {
  const roots = parseConformanceLocalPathEnv()
  if (roots.length === 0) return []

  const baselineDir = process.env.CONFORMANCE_LOCAL_BASELINE_DIR?.trim()
    ? resolve(process.env.CONFORMANCE_LOCAL_BASELINE_DIR.trim())
    : undefined
  const multiRoot = roots.length > 1

  const cases: LocalConformanceCase[] = []
  for (const root of roots) {
    const absRoot = resolve(root)
    const prefix = multiRoot
      ? rootSlug(absRoot, statSync(absRoot).isFile())
      : undefined
    cases.push(...discoverUnderRoot(root, baselineDir, prefix))
  }
  return cases
}

/** Like `resolveLocalConformanceCases` but returns an error instead of throwing. */
export function tryResolveLocalConformanceCases():
  | { ok: true; cases: LocalConformanceCase[] }
  | { ok: false; error: Error } {
  try {
    return { ok: true, cases: resolveLocalConformanceCases() }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}
