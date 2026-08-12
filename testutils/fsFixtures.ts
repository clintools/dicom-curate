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
}

/** Files per fixture tree; assert against it so an empty tree cannot pass. */
export const QUIRK_FIXTURE_FILE_COUNT = 3

/**
 * Create a temporary directory tree of valid DICOM files exercising one path
 * quirk. Caller owns cleanup of the returned `root` (e.g. via `rmSync`).
 */
export async function writeQuirkFixture(
  quirk: PathQuirk,
): Promise<FsQuirkFixture> {
  const root = mkdtempSync(join(tmpdir(), `fs-edge-${quirk}-`))

  const spec: DatasetSpec = {
    // Path segments are index-derived, so the tree is the same either way; the
    // seed only pins the generated UIDs, and hence the file bytes.
    seed: 1,
    layout: 'hierarchical',
    pathQuirks: [quirk],
    studies: [{ series: [{ instances: { count: QUIRK_FIXTURE_FILE_COUNT } }] }],
  }

  const manifest = await writeCollectionFromSpec(spec, root)

  return {
    root,
    relativePaths: manifest.map((m) => m.relativePath),
  }
}
