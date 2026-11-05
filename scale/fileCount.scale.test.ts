/**
 * File count: nothing dropped or double-written under sustained backpressure,
 * and no per-file memory retained by the orchestrator with
 * `skipCollectingMappings` set. `mapResultsList` is the only per-file structure
 * it keeps, so it decides whether a half-million-file run fits in memory.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { curateMany } from 'dicom-curate'
import type { OrganizeOptions } from '../src/types'
import {
  createIntegrationWorkspace,
  integrationOptions,
  integrationSpec,
  listFilesRecursive,
  type Workspace,
  writeImages,
} from '../testutils/integrationHarness'
import { measureRetainedHeap } from '../testutils/memory'

/** 200x the dispatch high-water mark (100), ~6s per run. Override with `SCALE_FILE_COUNT`. */
const FILE_COUNT = Number(process.env.SCALE_FILE_COUNT ?? 20_000)

/** Below this, fixed per-run heap (~200 KB) alone breaches the per-file ceiling. */
const MIN_FILE_COUNT = 5_000

// Also rejects an empty value, which would pass the accounting test with no files.
if (!Number.isInteger(FILE_COUNT) || FILE_COUNT < MIN_FILE_COUNT) {
  throw new Error(
    `SCALE_FILE_COUNT must be an integer of at least ${MIN_FILE_COUNT}, got '${process.env.SCALE_FILE_COUNT}'`,
  )
}

const WORKER_COUNT = 4

/**
 * Bytes retained per file with `skipCollectingMappings` on; measured near zero,
 * far below a retained `TMapResults`.
 */
const RETAINED_BYTES_PER_FILE_CEILING = 64

/** The collecting run must exceed the ceiling by this much, or the ceiling passes vacuously. */
const DISCRIMINATION_FACTOR = 4

/** One line per run from the mapping pool; at this volume it buries the measurements. */
const PROGRESS_CHATTER =
  /^(Finished mapping \d+ files|job is finished|directoryScanFinished)$/

/**
 * `curateMany` keeping only the final message and an error tally. The harness's
 * `runCapturingProgress` keeps every progress message, each with a `TMapResults`,
 * so it would retain the very structure under measurement.
 */
async function runQuietly(options: OrganizeOptions) {
  let errorCount = 0
  const done = await curateMany(options, (msg) => {
    if (msg.response === 'progress') {
      errorCount += msg.mapResults?.errors?.length ?? 0
    }
  })
  return { done, errorCount }
}

describe(`curateMany at ${FILE_COUNT.toLocaleString()} files`, () => {
  let workspace: Workspace
  let flushWorkspace: Workspace
  const originalConsoleLog = console.log

  beforeAll(async () => {
    console.log = (...args) => {
      if (args.length === 1 && PROGRESS_CHATTER.test(String(args[0]))) {
        return
      }
      originalConsoleLog.apply(console, args)
    }
    workspace = createIntegrationWorkspace()
    await writeImages(workspace.inputDir, FILE_COUNT)
    flushWorkspace = createIntegrationWorkspace()
    await writeImages(flushWorkspace.inputDir, 1)
  })

  afterAll(() => {
    console.log = originalConsoleLog
    workspace?.cleanup()
    flushWorkspace?.cleanup()
  })

  /**
   * The pool holds the previous run's results until the next run starts. Without
   * a one-file run first, the baseline includes them, and a leak in the measured
   * run cancels out as they are freed.
   */
  async function flushPoolState(): Promise<void> {
    await runQuietly(
      integrationOptions(
        flushWorkspace.inputDir,
        flushWorkspace.outputDir,
        integrationSpec(),
        { workerCount: 1, skipCollectingMappings: true },
      ),
    )
  }

  /** Each test writes to its own subtree so output counts cannot overlap. */
  function outputDir(name: string): string {
    const dir = join(workspace.outputDir, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async function measureRetainedPerFile(
    name: string,
    skipCollectingMappings: boolean,
  ) {
    await flushPoolState()
    const { value, retainedBytes } = await measureRetainedHeap(() =>
      runQuietly(
        integrationOptions(
          workspace.inputDir,
          outputDir(name),
          integrationSpec(),
          { workerCount: WORKER_COUNT, skipCollectingMappings },
        ),
      ),
    )
    return { done: value.done, perFile: retainedBytes / FILE_COUNT }
  }

  it('processes and writes every file under sustained backpressure', async () => {
    const outDir = outputDir('accounting')

    const { done, errorCount } = await runQuietly(
      integrationOptions(workspace.inputDir, outDir, integrationSpec(), {
        workerCount: WORKER_COUNT,
        skipCollectingMappings: true,
      }),
    )

    expect(errorCount).toBe(0)
    expect(done.processedFiles).toBe(FILE_COUNT)

    // Output leaves are <Modality>_<sourceInstanceUID>.dcm, so a file mapped
    // twice would collapse onto one path rather than showing up as a duplicate
    // — an exact count is what catches it.
    expect(listFilesRecursive(outDir)).toHaveLength(FILE_COUNT)
  })

  it('retains no per-file memory when skipping mapping collection', async () => {
    const skipped = await measureRetainedPerFile('skip-collecting', true)
    const collected = await measureRetainedPerFile('collecting', false)

    console.log(
      `retained per file: skipCollectingMappings=${skipped.perFile.toFixed(1)}B, collecting=${collected.perFile.toFixed(1)}B`,
    )

    // Guards against measuring a no-op.
    expect(skipped.done.processedFiles).toBe(FILE_COUNT)
    expect(collected.done.processedFiles).toBe(FILE_COUNT)
    expect(skipped.done.mapResultsList).toHaveLength(0)
    expect(collected.done.mapResultsList).toHaveLength(FILE_COUNT)

    expect(skipped.perFile).toBeLessThan(RETAINED_BYTES_PER_FILE_CEILING)
    expect(collected.perFile).toBeGreaterThan(
      RETAINED_BYTES_PER_FILE_CEILING * DISCRIMINATION_FACTOR,
    )
  })
})
