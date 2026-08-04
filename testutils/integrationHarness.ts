/**
 * Harness for the `integration` vitest project.
 *
 * Integration tests drive real workers loaded from `dist/esm` (the
 * `dicom-curate` alias in vitest.config.ts), because `curateMany` constructs
 * its workers from `new URL('./*.js', import.meta.url)` and offers no
 * injection seam.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { curateMany } from 'dicom-curate'
import { type DicomTagOverrides, generateFile } from 'dicom-synth'
import type {
  OrganizeOptions,
  TCurationSpecification,
  TProgressMessage,
} from '../src/types'

export type IntegrationWorkspace = {
  inputDir: string
  outputDir: string
  cleanup: () => void
}

/** Fail fast when input and output trees could collide. */
function assertDisjoint(inputDir: string, outputDir: string): void {
  const input = resolve(inputDir)
  const output = resolve(outputDir)
  if (input === output || output.startsWith(input + sep)) {
    throw new Error(`output dir must not sit inside input dir: ${output}`)
  }
}

export function createIntegrationWorkspace(): IntegrationWorkspace {
  const base = mkdtempSync(join(tmpdir(), 'dicom-curate-integration-'))
  const inputDir = join(base, 'input')
  const outputDir = join(base, 'output')
  mkdirSync(inputDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  assertDisjoint(inputDir, outputDir)
  return {
    inputDir,
    outputDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

/**
 * Write one valid CT instance to an exact path.
 *
 * Generated directly from dicom-synth so this layer does not depend on the
 * fixture helpers in minimalDicom.ts, which are being reworked in parallel.
 * Collapse into that module's `writeSynthFile` once the two land together.
 */
export async function writeImage(
  filePath: string,
  tags?: DicomTagOverrides,
): Promise<void> {
  const { buffer } = await generateFile({
    type: 'valid-image',
    modality: 'CT',
    ...(tags ? { tags } : {}),
  })
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, buffer)
}

/** Minimal spec mirroring an `input/study/subject` tree. */
export function integrationSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'integration' },
    inputPathPattern: 'study/subject',
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      'curated',
      parser.getFilePathComp('subject'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })
}

/**
 * Overridable fields only. Spreading a full `Partial<OrganizeOptions>` would
 * widen `inputDirectory` back to the union shared with the 'directory' input
 * variant, breaking the 'path' narrowing below.
 */
export type IntegrationOverrides = Partial<
  Pick<
    OrganizeOptions,
    | 'workerCount'
    | 'skipWrite'
    | 'hashMethod'
    | 'dateOffset'
    | 'signal'
    | 'skipCollectingMappings'
  >
>

export function integrationOptions(
  inputDir: string,
  outputDir: string,
  curationSpec: OrganizeOptions['curationSpec'],
  overrides?: IntegrationOverrides,
): OrganizeOptions {
  assertDisjoint(inputDir, outputDir)
  return {
    inputType: 'path',
    inputDirectory: inputDir,
    outputDirectory: outputDir,
    curationSpec,
    workerCount: 1,
    ...overrides,
  }
}

export type CapturedRun = {
  result: Awaited<ReturnType<typeof curateMany>>
  /** Every progress message, in order — the intermediate behaviour under test. */
  progress: TProgressMessage[]
}

/** Run `curateMany` against real workers, retaining the progress stream. */
export async function runCapturingProgress(
  options: OrganizeOptions,
): Promise<CapturedRun> {
  const progress: TProgressMessage[] = []
  const result = await curateMany(options, (msg: TProgressMessage) => {
    progress.push(msg)
  })
  return { result, progress }
}
