import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DatasetSpec, writeCollectionFromSpec } from 'dicom-synth'
import { curateOne } from '../src/curateOne'
import type { TCurationSpecification, TMappingOptions } from '../src/types'

export { resolveConformanceBin } from './resolveBin'

const conformanceRoot = dirname(fileURLToPath(import.meta.url))

export const repoRoot = join(conformanceRoot, '..')

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

// Deterministic conformance fixture set — one of each image conformance
// flavour. Generated inline from a dicom-synth DatasetSpec
export const CONFORMANCE_SPEC: DatasetSpec = {
  seed: 1,
  entries: [
    { type: 'valid-image' },
    { type: 'invalid-uid-image' },
    { type: 'vendor-warnings-image' },
  ],
}

export async function writeSyntheticConformanceFixtures(
  dir: string,
): Promise<ConformanceFixtureCase[]> {
  const manifest = await writeCollectionFromSpec(CONFORMANCE_SPEC, dir)
  return manifest.map(({ path, relativePath }) => {
    const id = basename(relativePath).replace(/\.dcm$/, '')
    return {
      id,
      dicomPath: path,
      baselinePath: syntheticBaselinePath(id),
    }
  })
}
