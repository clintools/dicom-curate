/**
 * Orchestration behaviour that only real workers can demonstrate.
 *
 * The mock-worker suites (workerCrashRecovery, abortSignal, scannerCounting,
 * mappingWorkerPool) already cover the logic of crash recovery, abort and
 * counting. What they cannot cover is real thread scheduling: no test anywhere
 * exercises `workerCount > 1`, and the scan worker's 'stop'/'resume'
 * backpressure round-trip is driven by `index.ts` against a live worker.
 */
import {
  integrationOptions,
  integrationSpec,
  listFilesRecursive,
  runCapturingProgress,
  runExpectingRejection,
  useWorkspaces,
  writeImages,
} from '../testutils/integrationHarness'

describe('curateMany orchestration with real workers', () => {
  const workspace = useWorkspaces()

  it('processes every file exactly once across a pool of four workers', async () => {
    const { inputDir, outputDir } = workspace()
    const count = 40
    await writeImages(inputDir, count)

    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 4,
      }),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)
    expect(result.mapResultsList).toHaveLength(count)

    // Nothing dropped and nothing double-written: output paths are the
    // collision-avoiding <Modality>_<sourceInstanceUID>.dcm, so a duplicate
    // would collapse two results onto one path.
    const outputPaths = (result.mapResultsList ?? []).map(
      (r) => r.outputFilePath,
    )
    expect(new Set(outputPaths).size).toBe(count)
    expect(listFilesRecursive(outputDir)).toHaveLength(count)

    // Each source file is represented exactly once.
    const sourceNames = (result.mapResultsList ?? [])
      .map((r) => r.fileInfo?.name)
      .filter((n): n is string => typeof n === 'string')
    expect(new Set(sourceNames).size).toBe(count)
  })

  it('completes correctly on a queue deep enough to trigger scan backpressure', async () => {
    const { inputDir, outputDir } = workspace()
    // index.ts pauses the scan worker above a HIGH_WATER_MARK of 100 queued
    // files and resumes on drain. 'stop'/'resume' are not observable from
    // outside, so this asserts correctness under conditions that provoke the
    // round-trip rather than asserting the messages themselves.
    const count = 250
    await writeImages(inputDir, count)

    const { result, progress } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 1,
      }),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)
    expect(listFilesRecursive(outputDir)).toHaveLength(count)

    // Truthful end to end: the scanner is still running when the first files
    // come back, so totalFiles is provisional at that point and exact at 'done'.
    expect(progress[0].scanComplete).toBe(false)
    expect(progress.at(-1)).toMatchObject({
      response: 'done',
      scanComplete: true,
    })

    // The count must never overshoot the discovered total, in any message —
    // a pause/resume that lost or replayed a file would break this.
    for (const msg of progress) {
      if (
        typeof msg.processedFiles === 'number' &&
        typeof msg.totalFiles === 'number'
      ) {
        expect(msg.processedFiles).toBeLessThanOrEqual(msg.totalFiles)
      }
    }
  })

  it('completes under backpressure when the consumer callback throws on every message', async () => {
    const { inputDir, outputDir } = workspace()
    // The full deadlock: a consumer throw lands between `workersActive -= 1`
    // and the re-dispatch, and dispatch is the only thing that resumes a
    // scanner paused on backpressure. One throw used to strand the run.
    const count = 250
    await writeImages(inputDir, count)

    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 1,
      }),
      () => {
        throw new Error('consumer callback exploded')
      },
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)
    expect(listFilesRecursive(outputDir)).toHaveLength(count)
  })

  it('aborts a live run and leaves the input reusable by the next run', async () => {
    const { inputDir, outputDir } = workspace()
    const count = 120
    await writeImages(inputDir, count)

    const controller = new AbortController()
    // Abort on the first file actually processed, not on a timer — otherwise
    // whether work was in flight is a race, and the mock suite already covers
    // aborting before startup.
    const { progress, error } = await runExpectingRejection(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 2,
        signal: controller.signal,
      }),
      (msg) => {
        if (
          !controller.signal.aborted &&
          msg.response === 'progress' &&
          (msg.processedFiles ?? 0) >= 1
        ) {
          controller.abort()
        }
      },
    )

    expect(error).toMatchObject({ name: 'AbortError' })
    // Confirms the run really was mid-flight when aborted, and that it did not
    // silently run to completion.
    expect(progress.some((m) => (m.processedFiles ?? 0) >= 1)).toBe(true)
    expect(progress.some((m) => m.response === 'done')).toBe(false)

    // Real workers were hard-terminated. A fresh run over the same input must
    // still complete — partial output from the aborted run is re-processed.
    //
    // KNOWN RACE (#302): mappingWorkerPool holds its state at module level and
    // the next run resets `aborted` to false. A message still in flight from a
    // terminated run-1 worker can therefore pass the `if (aborted) return`
    // guard in the message handler and act on run-2 state — not just the
    // counters, but pushing the terminated worker back onto
    // availableMappingWorkers, so run 2 may dispatch to a dead thread and
    // stall. If this assertion ever flakes, that is the cause — it is a
    // product bug, not a test bug.
    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 2,
      }),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)
    expect(listFilesRecursive(outputDir)).toHaveLength(count)
  })
})
