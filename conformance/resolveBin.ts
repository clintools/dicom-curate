import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDciodvfyBinary } from './dciodvfy'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const localDciodvfy = join(
  repoRoot,
  '.cache-dciodvfy/extracted/usr/bin/dciodvfy',
)

/** Resolve `dciodvfy` for conformance (env, PATH, or repo-local cache). */
export function resolveConformanceBin(): string | undefined {
  return (
    resolveDciodvfyBinary() ??
    (existsSync(localDciodvfy) ? localDciodvfy : undefined)
  )
}
