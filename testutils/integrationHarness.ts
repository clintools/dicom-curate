/**
 * Harness for the `integration` vitest project.
 *
 * Integration tests drive real workers loaded from `dist/esm` (the
 * `dicom-curate` alias in vitest.config.ts), because `curateMany` constructs
 * its workers from `new URL('./*.js', import.meta.url)` and offers no
 * injection seam.
 */
import { join } from 'node:path'
import { curateMany } from 'dicom-curate'
import { afterEach } from 'vitest'
import type {
  OrganizeOptions,
  TCurationSpecification,
  TProgressMessage,
} from '../src/types'
import { VALID_CT_IMAGE, writeSynthFile } from './synthFixtures'
import {
  assertInputOutputDisjoint,
  createWorkspace,
  INPUT_DIR_NAME,
  type Workspace,
} from './workspace'

export { listFilesRecursive, type Workspace } from './workspace'

export function createIntegrationWorkspace(): Workspace {
  return createWorkspace('dicom-curate-integration-')
}

// The specs below hard-code `input/...` because spec functions are serialized
// to the worker and cannot close over variables. Fail loudly if the workspace
// layout ever stops matching that literal.
if (INPUT_DIR_NAME !== 'input') {
  throw new Error(
    `integrationHarness specs hard-code 'input/...' but INPUT_DIR_NAME is '${INPUT_DIR_NAME}'`,
  )
}

/**
 * Register per-test workspace cleanup and return a factory for them. Call once
 * inside a `describe`; every workspace it hands out is removed after each test.
 */
export function useWorkspaces(): () => Workspace {
  const workspaces: Workspace[] = []
  afterEach(() => {
    for (const w of workspaces.splice(0)) {
      w.cleanup()
    }
  })
  return () => {
    const w = createIntegrationWorkspace()
    workspaces.push(w)
    return w
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

/**
 * Minimal spec mirroring the `input/study/subject` tree `createWorkspace`
 * builds.
 *
 * The pattern's leading `input` is required, not incidental: scanned paths are
 * relative to the scan root's parent, so they start with the input directory's
 * own basename. Omitting it shifts every `getFilePathComp` lookup by one and
 * silently returns the wrong segment rather than erroring.
 *
 * It must stay an inline literal — spec functions are serialized to the worker
 * and `checkClosure` rejects any closed-over variable, so this cannot reference
 * `INPUT_DIR_NAME`. The assertion below keeps the two in step.
 */
export function integrationSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'integration' },
    inputPathPattern: 'input/study/subject',
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
 * Spec for the direct CSV-load mapping flow (`additionalData.type: 'load'`):
 * PatientID is rewritten from a supplied `table`, joined on the original
 * value. Requires `table: [{ oldId, newId }]` on the options.
 *
 * Not the two-pass flow — that is `type: 'listing'`, which derives its mapping
 * from a first read-only pass instead of a caller-supplied table.
 */
export function csvMappingSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: {},
    // Inline literal, and must include the input dir basename — see
    // integrationSpec above.
    inputPathPattern: 'input/study/subject',
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: (parser) => {
      // Without a `table`, getMapping is undefined and `String(undefined)`
      // would write the literal 'undefined' as PatientID with no error at all.
      if (!parser.getMapping) {
        throw new Error(
          'csvMappingSpec requires `table` in the curate options (no mapping resolver was supplied)',
        )
      }
      return { PatientID: String(parser.getMapping('centerSubjectId')) }
    },
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
  assertInputOutputDisjoint(inputDir, outputDir)
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
 *
 * Throws if the run *completes*: a caller using this expects a rejection, and
 * surfacing that as `error: undefined` would turn a real regression into a
 * confusing assertion mismatch further down the test.
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
  } catch (error) {
    return { progress, error }
  }
  throw new Error(
    `expected curateMany to reject, but it completed after ${progress.length} progress messages`,
  )
}
