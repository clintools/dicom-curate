/**
 * Harness for the `integration` vitest project.
 *
 * Integration tests drive real workers loaded from `dist/esm` (the
 * `dicom-curate` alias in vitest.config.ts), because `curateMany` constructs
 * its workers from `new URL('./*.js', import.meta.url)` and offers no
 * injection seam.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { curateMany } from 'dicom-curate'
import type {
  OrganizeOptions,
  TCurationSpecification,
  TProgressMessage,
} from '../src/types'
import { VALID_CT_IMAGE, writeSynthFile } from './synthFixtures'

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

export type WrittenImage = {
  /** Leaf filename under `study/subject/`. */
  name: string
  /** PatientID written into the instance, for matching results to sources. */
  patientId: string
}

/**
 * Write `count` instances into `study/subject/` under `inputDir`.
 *
 * Each gets a unique PatientID so results can be matched back to their source,
 * and a distinct `index` so the generated SOPInstanceUIDs differ — output
 * filenames derive from that UID, so identical instances would collapse onto
 * one path.
 *
 * Returns what was written: read the ids from here rather than re-deriving the
 * naming convention, so callers cannot silently drift from it.
 */
export async function writeImages(
  inputDir: string,
  count: number,
): Promise<WrittenImage[]> {
  const written: WrittenImage[] = []
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(4, '0')
    const name = `instance-${id}.dcm`
    const patientId = `PID-${id}`
    await writeSynthFile(
      join(inputDir, 'study', 'subject', name),
      { ...VALID_CT_IMAGE, tags: { PatientID: patientId } },
      { index: i },
    )
    written.push({ name, patientId })
  }
  return written
}

/** Every file under `dir`, recursively, as paths relative to `dir`. */
export function listFilesRecursive(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full, rel))
    } else {
      out.push(rel)
    }
  }
  return out
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
    | 'table'
  >
>

/**
 * Spec for the CSV-load (two-pass) mapping flow: PatientID is rewritten from a
 * `table` joined on the original value. Pair with `table: [{ oldId, newId }]`
 * on the options.
 */
export function csvMappingSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: {},
    inputPathPattern: 'study/subject',
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: (parser) => ({
      PatientID: String(parser.getMapping?.('centerSubjectId')),
    }),
    additionalData: {
      type: 'load',
      collect: {},
      mapping: {
        centerSubjectId: {
          value: (p) => p.getDicom('PatientID'),
          lookup: (row) => String(row.oldId),
          replace: (row) => String(row.newId),
        },
      },
    },
    outputFilePathComponents: (parser) => [
      'curated',
      parser.getFilePathComp('subject'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })
}

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

/**
 * Run `curateMany` against real workers, retaining the progress stream.
 * `onMessage` fires for each message, so a test can act once work is genuinely
 * in flight rather than guessing with a timer.
 */
export async function runCapturingProgress(
  options: OrganizeOptions,
  onMessage?: (msg: TProgressMessage) => void,
): Promise<CapturedRun> {
  const progress: TProgressMessage[] = []
  const result = await curateMany(options, (msg: TProgressMessage) => {
    progress.push(msg)
    onMessage?.(msg)
  })
  return { result, progress }
}

/**
 * As above, but resolves with the rejection instead of throwing — so the
 * progress captured before a failure stays inspectable.
 */
export async function runExpectingRejection(
  options: OrganizeOptions,
  onMessage?: (msg: TProgressMessage) => void,
): Promise<{ progress: TProgressMessage[]; error: unknown }> {
  const progress: TProgressMessage[] = []
  try {
    await curateMany(options, (msg: TProgressMessage) => {
      progress.push(msg)
      onMessage?.(msg)
    })
    return { progress, error: undefined }
  } catch (error) {
    return { progress, error }
  }
}
