import { existsSync, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SYNTHETIC_FIXTURES,
  type SyntheticCtVariant,
  writeSyntheticFixturesToDir,
} from 'dicom-synth'
import { curateOne } from '../src/curateOne'
import type { TCurationSpecification, TMappingOptions } from '../src/types'
import { resolveDciodvfyBinary } from './dciodvfy'

const conformanceRoot = dirname(fileURLToPath(import.meta.url))

export const repoRoot = join(conformanceRoot, '..')

export const syntheticBaselinesDir = join(
  conformanceRoot,
  'baselines/synthetic',
)

export const publicBaselinesDir = join(conformanceRoot, 'baselines/public')

let syntheticFixturesDirCache: string | undefined

/** Ephemeral synthetic DICOM files (from dicom-synth) */
export function getSyntheticFixturesDir(): string {
  if (!syntheticFixturesDirCache) {
    syntheticFixturesDirCache = mkdtempSync(
      join(tmpdir(), 'dc-conformance-synth-'),
    )
    writeSyntheticFixturesToDir(syntheticFixturesDirCache)
  }
  return syntheticFixturesDirCache
}

export const localDciodvfy = join(
  repoRoot,
  '.cache-dciodvfy/extracted/usr/bin/dciodvfy',
)

export function resolveConformanceBin(): string | undefined {
  return (
    resolveDciodvfyBinary() ??
    (existsSync(localDciodvfy) ? localDciodvfy : undefined)
  )
}

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
  variant: SyntheticCtVariant
}

type SyntheticFixtureCatalogEntry = {
  filename: string
  variant: SyntheticCtVariant
  description: string
}

export const syntheticConformanceCases: ConformanceFixtureCase[] = (
  SYNTHETIC_FIXTURES as readonly SyntheticFixtureCatalogEntry[]
).map(({ filename, variant }) => {
  const id = filename.replace(/\.dcm$/, '')
  return {
    id,
    dicomPath: join(getSyntheticFixturesDir(), filename),
    baselinePath: syntheticBaselinePath(id),
    variant,
  }
})
