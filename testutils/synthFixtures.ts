/**
 * dicom-synth-backed fixture writers: single files at a caller-chosen path,
 * and whole directory trees whose paths exercise one filesystem quirk.
 *
 * Hand-built dcmjs fixtures live in dicomdirFixture.ts and dicomFixtures.ts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DatasetSpec,
  type FileSpec,
  generateFile,
  type PathQuirk,
  type ValidImageSpec,
  writeCollectionFromSpec,
} from 'dicom-synth'

/**
 * Spread to override tags, e.g.
 * `{ ...VALID_CT_IMAGE, tags: { PatientID: 'OLD-ID' } }`.
 *
 * Modality is pinned because output paths and anomaly messages are asserted
 * against it in several tests.
 */
export const VALID_CT_IMAGE: ValidImageSpec = {
  type: 'valid-image',
  modality: 'CT',
}

// Unseeded, generateFile mints random UIDs per call, so fixture bytes would
// differ run to run. Pinning restores the constant UIDs the hand-rolled dcmjs
// helper produced; pass a distinct `index` here if a test ever needs two
// instances that differ.
const FIXTURE_SEED = 1

/**
 * Exists because dicom-synth has no equivalent: `generateFile` performs no
 * I/O, and `writeCollectionFromSpec` derives its own filenames and layout, so
 * neither can target the caller-chosen paths these tests assert on.
 */
export async function writeSynthFile(
  filePath: string,
  spec: FileSpec,
): Promise<void> {
  const { buffer } = await generateFile(spec, { seed: FIXTURE_SEED })
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, buffer)
}

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
 *
 * Trailing dots are the notable hazard: they broke the Chrome File System
 * Access API on deep trees, and Win32 strips them.
 *
 * The layout is hierarchical because the quirks that matter most (trailing
 * dots, unicode, long names) apply to directory segments, which only exist
 * when files nest under study/series directories rather than in a flat list.
 */
export async function writeQuirkFixture(
  quirk: PathQuirk,
): Promise<FsQuirkFixture> {
  const root = mkdtempSync(join(tmpdir(), `fs-edge-${quirk}-`))

  const spec: DatasetSpec = {
    // Path segments are index-derived, so the tree is the same either way; the
    // seed only pins the generated UIDs, and hence the file bytes.
    seed: FIXTURE_SEED,
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
