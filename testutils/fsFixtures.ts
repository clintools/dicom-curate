/**
 * Filesystem-interaction test harness for edge-case directory trees.
 *
 * Materialises real DICOM trees on disk whose paths exercise a single
 * dicom-synth path quirk. Trailing dots are the notable hazard: they broke the
 * Chrome File System Access API on deep trees, and Win32 strips them.
 *
 * The layout is hierarchical because the quirks that matter most (trailing
 * dots, unicode, long names) apply to directory segments, which only exist
 * when files nest under study/series directories rather than in a flat list.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DatasetSpec,
  type PathQuirk,
  writeCollectionFromSpec,
} from 'dicom-synth'

export type FsQuirkFixture = {
  /** Absolute path to the fixture root directory. */
  root: string
  /** POSIX-style paths of the generated DICOM files, relative to `root`. */
  relativePaths: string[]
  /** Leaf filenames of the generated DICOM files. */
  filenames: string[]
}

/**
 * Create a temporary directory tree of valid DICOM files exercising one path
 * quirk. Caller owns cleanup of the returned `root` (e.g. via `rmSync`).
 *
 * A fixed `seed` keeps the generated UIDs — and thus the tree — deterministic.
 */
export async function writeQuirkFixture(
  quirk: PathQuirk,
  options?: { count?: number; seed?: number },
): Promise<FsQuirkFixture> {
  const count = options?.count ?? 3
  const seed = options?.seed ?? 42

  const root = mkdtempSync(join(tmpdir(), `fs-edge-${quirk}-`))

  const spec: DatasetSpec = {
    seed,
    layout: 'hierarchical',
    pathQuirks: [quirk],
    studies: [{ series: [{ instances: { count } }] }],
  }

  const manifest = await writeCollectionFromSpec(spec, root)

  return {
    root,
    relativePaths: manifest.map((m) => m.relativePath),
    filenames: manifest.map((m) => m.relativePath.split('/').pop() ?? ''),
  }
}
