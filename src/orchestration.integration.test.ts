/**
 * Orchestration behaviour that only real workers can demonstrate.
 *
 * The mock-worker suites (workerCrashRecovery, abortSignal, scannerCounting,
 * mappingWorkerPool) already cover the logic of crash recovery, abort and
 * counting. What they cannot cover is real thread scheduling: no test anywhere
 * exercises `workerCount > 1`, and the scan worker's 'stop'/'resume'
 * backpressure round-trip is driven by `index.ts` against a live worker.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createIntegrationWorkspace,
  type IntegrationWorkspace,
  integrationOptions,
  integrationSpec,
  runCapturingProgress,
  runExpectingRejection,
  writeImages,
} from '../testutils/integrationHarness'

/** Every file under `dir`, recursively, as paths relative to `dir`. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

describe('curateMany orchestration with real workers', () => {
  const workspaces: IntegrationWorkspace[] = []

  afterEach(() => {
    for (const w of workspaces.splice(0)) {
      w.cleanup()
    }
  })

  function workspace(): IntegrationWorkspace {
    const w = createIntegrationWorkspace()
    workspaces.push(w)
    return w
  }

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
    expect(listFiles(outputDir)).toHaveLength(count)

    // Each source file is represented exactly once.
    const patientIds = (result.mapResultsList ?? [])
      .map((r) => r.fileInfo?.name)
      .filter((n): n is string => typeof n === 'string')
    expect(new Set(patientIds).size).toBe(count)
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
    expect(listFiles(outputDir)).toHaveLength(count)

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
    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec(), {
        workerCount: 2,
      }),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)
    expect(listFiles(outputDir)).toHaveLength(count)
  })
})
