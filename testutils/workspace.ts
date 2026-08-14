/**
 * Temp input/output workspaces and directory helpers, shared by the e2e and
 * integration suites.
 *
 * Both layers need the same disjointness guard and recursive listing; keeping
 * one copy here stops the two drifting apart.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export type Workspace = {
  inputDir: string
  outputDir: string
  cleanup: () => void
}

/** Fail fast when input and output trees could collide, in either direction. */
export function assertInputOutputDisjoint(
  inputDir: string,
  outputDir: string,
): void {
  const input = resolve(inputDir)
  const output = resolve(outputDir)
  if (
    input === output ||
    input.startsWith(output + sep) ||
    output.startsWith(input + sep)
  ) {
    throw new Error(
      `Input and output directories must not overlap (input=${input}, output=${output})`,
    )
  }
}

/**
 * The basename of the input directory created below. Scanned paths are
 * relative to the scan root's *parent*, so they start with this segment — any
 * `inputPathPattern` matching against them must account for it.
 */
export const INPUT_DIR_NAME = 'input'

export function createWorkspace(prefix: string): Workspace {
  const base = mkdtempSync(join(tmpdir(), prefix))
  const inputDir = join(base, INPUT_DIR_NAME)
  const outputDir = join(base, 'output')
  mkdirSync(inputDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  assertInputOutputDisjoint(inputDir, outputDir)
  return {
    inputDir,
    outputDir,
    cleanup: () => {
      if (existsSync(base)) {
        rmSync(base, { recursive: true, force: true })
      }
    },
  }
}

/** Every file under `root`, recursively, sorted, relative to `root`. */
export function listFilesRecursive(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        files.push(relative(root, full))
      }
    }
  }
  if (existsSync(root)) {
    walk(root)
  }
  return files.sort()
}

export function hashDirectoryFiles(root: string): Map<string, string> {
  const hashes = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        hashes.set(
          relative(root, full),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        )
      }
    }
  }
  if (existsSync(root)) {
    walk(root)
  }
  return hashes
}
