import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type DatasetSpec,
  type ViolationClass,
  writeCollectionFromSpec,
} from 'dicom-synth'
import { curateOne } from '../src/curateOne'
import type { TCurationSpecification, TMappingOptions } from '../src/types'

export { resolveConformanceBin } from './resolveBin'

const conformanceRoot = dirname(fileURLToPath(import.meta.url))

export const syntheticBaselinesDir = join(
  conformanceRoot,
  'baselines/synthetic',
)

export const publicBaselinesDir = join(conformanceRoot, 'baselines/public')

export function syntheticBaselinePath(fixtureId: string): string {
  return join(syntheticBaselinesDir, `${fixtureId}.dciodvfy-baseline.json`)
}

export function publicBaselinePath(caseId: string): string {
  return join(publicBaselinesDir, `${caseId}.dciodvfy-baseline.json`)
}

export function passthroughSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    inputPathPattern: 'any',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      'out',
      `${parser.getFilePathComp(parser.FILENAME)}`,
    ],
    errors: () => [],
  })
}

const passthroughMappingOptions = (): TMappingOptions => ({
  curationSpec: passthroughSpec(),
  skipWrite: false,
})

/** Passthrough `curateOne` on a fixture file; returns path to written output. */
export async function runPassthroughCurate(
  dicomPath: string,
  outDir: string,
): Promise<string> {
  const buf = await readFile(dicomPath)
  const name = basename(dicomPath)
  const result = await curateOne({
    fileInfo: {
      kind: 'path',
      fullPath: dicomPath,
      path: 'conformance',
      name,
      size: buf.length,
    },
    outputTarget: { directory: outDir },
    mappingOptions: passthroughMappingOptions(),
  })
  if (!result.outputFilePath) {
    const detail =
      result.errors?.join('; ') ??
      'no outputFilePath (parse or mapping failure)'
    throw new Error(`curateOne failed for ${name}: ${detail}`)
  }
  return join(outDir, result.outputFilePath)
}

export type ConformanceFixtureCase = {
  id: string
  dicomPath: string
  baselinePath: string
}

/**
 * Shared by CONFORMANCE_SPEC and VIOLATION_SPEC. The discrimination check in
 * dciodvfy.violations.test.ts compares each violation baseline against the
 * clean fixture's, which is only meaningful while both specs generate the same
 * base image — diverging seeds would add unrelated baseline differences that
 * let a neutered violation fixture pass vacuously.
 */
const SYNTHETIC_SEED = 1

/**
 * The clean `valid-image` fixture that violation baselines are compared
 * against. Must name a CONFORMANCE_SPEC fixture: the spec uses `entries`, so
 * dicom-synth derives ids as `<type>-<ordinal>` — reordering or renaming
 * entries changes this id and must be reflected here.
 */
export const CLEAN_FIXTURE_ID = 'valid-image-0'

// Deterministic conformance fixture set — one of each image conformance
// flavour. Generated inline from a dicom-synth DatasetSpec
export const CONFORMANCE_SPEC: DatasetSpec = {
  seed: SYNTHETIC_SEED,
  entries: [
    { type: 'valid-image' },
    { type: 'invalid-uid-image' },
    { type: 'vendor-warnings-image' },
  ],
}

export async function writeSyntheticConformanceFixtures(
  dir: string,
): Promise<ConformanceFixtureCase[]> {
  return writeFixturesFromSpec(CONFORMANCE_SPEC, dir)
}

/**
 * dicom-synth's full declared violation vocabulary.
 *
 * These are the *enumerable* deviations — the classes a generator can produce
 * on purpose. They shrink, but do not remove, the need for a corpus of real
 * dirty files: that exists for the deviations nobody thought to name.
 */
export const VIOLATION_CLASSES = [
  'uid-too-long',
  'non-conformant-uid',
  'missing-meta-header',
  'malformed-sq-delimiter',
  'vr-max-length-exceeded',
  'missing-type1-tag',
] as const satisfies readonly ViolationClass[]

// `satisfies` above only proves every listed name is a real class, not that
// every real class is listed. This fails to compile if dicom-synth adds one:
// the conditional collapses to `never` and `= true` is then unassignable.
const _violationVocabularyIsExhaustive: ViolationClass extends (typeof VIOLATION_CLASSES)[number]
  ? true
  : never = true

/**
 * One fixture per violation class: a valid image carrying exactly one
 * deliberate deviation.
 *
 * Uses `tree` rather than `entries` so each file is named for its class. With
 * `entries` every one would be `valid-image-N`, putting the class in the
 * ordinal alone — reordering the list would then repoint each committed
 * baseline at a different violation without changing a filename.
 */
export const VIOLATION_SPEC: DatasetSpec = {
  seed: SYNTHETIC_SEED,
  tree: VIOLATION_CLASSES.map((violation) => ({
    type: 'valid-image',
    violations: [violation],
    name: `violation-${violation}.dcm`,
  })),
}

export async function writeSyntheticViolationFixtures(
  dir: string,
): Promise<ConformanceFixtureCase[]> {
  return writeFixturesFromSpec(VIOLATION_SPEC, dir)
}

async function writeFixturesFromSpec(
  spec: DatasetSpec,
  dir: string,
): Promise<ConformanceFixtureCase[]> {
  const manifest = await writeCollectionFromSpec(spec, dir)
  return manifest.map(({ path, relativePath }) => {
    const id = basename(relativePath).replace(/\.dcm$/, '')
    return {
      id,
      dicomPath: path,
      baselinePath: syntheticBaselinePath(id),
    }
  })
}
