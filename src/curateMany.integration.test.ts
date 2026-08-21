/**
 * Seed tests for the `integration` project — see testutils/integrationHarness.ts.
 *
 * These assert intermediate behaviour observable only with real workers: that
 * the scan and mapping workers actually round-trip, and that per-file results
 * reach the caller through the progress stream as work proceeds rather than
 * only in the final result.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  integrationOptions,
  integrationSpec,
  runCapturingProgress,
  useWorkspaces,
} from '../testutils/integrationHarness'
import { VALID_CT_IMAGE, writeSynthFile } from '../testutils/synthFixtures'

describe('curateMany driven through real workers', () => {
  const workspace = useWorkspaces()

  it('reports progress incrementally before the run completes', async () => {
    const { inputDir, outputDir } = workspace()
    // Distinct index per file: output filenames derive from SOPInstanceUID, so
    // identical instances would collapse onto a single output path.
    for (const [i, n] of ['a', 'b', 'c'].entries()) {
      await writeSynthFile(
        join(inputDir, 'study', 'subject', `${n}.dcm`),
        VALID_CT_IMAGE,
        { index: i },
      )
    }

    const { result, progress } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(3)

    // The point of this layer: work is observable while in flight, which only
    // holds when the workers genuinely round-trip.
    const doneIndex = progress.findIndex((m) => m.response === 'done')
    // Guard the slice below: -1 would silently drop the last message instead.
    expect(doneIndex).toBeGreaterThan(-1)
    const beforeDone = progress.slice(0, doneIndex)
    expect(beforeDone.length).toBeGreaterThan(0)
    expect(beforeDone.every((m) => m.response === 'progress')).toBe(true)

    const counts = beforeDone
      .map((m) => m.processedFiles)
      .filter((n): n is number => typeof n === 'number')
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
  })

  it('completes for in-memory file input, which never runs a scan', async () => {
    const { inputDir, outputDir } = workspace()
    const inputPath = join(inputDir, 'study', 'subject', 'only.dcm')
    await writeSynthFile(inputPath, VALID_CT_IMAGE)

    // No scan worker exists on this path, so nothing but queueFilesForMapping
    // can mark the scan finished -- and without that the run never settles.
    const { result } = await runCapturingProgress({
      ...integrationOptions(inputDir, outputDir, integrationSpec()),
      inputType: 'files',
      inputFiles: [
        new File([Uint8Array.from(await readFile(inputPath))], 'only.dcm'),
      ],
    } as never)

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(1)
  })

  it('settles on an empty queue for both directly-queued input types', async () => {
    const { inputDir, outputDir } = workspace()
    const base = integrationOptions(inputDir, outputDir, integrationSpec())

    // Neither input type runs a scan, so an empty list is the shortest path to
    // the termination condition -- and the one that never reaches a worker.
    const files = await runCapturingProgress({
      ...base,
      inputType: 'files',
      inputFiles: [],
    } as never)
    expect(files.result.response).toBe('done')
    expect(files.result.processedFiles).toBe(0)

    const urls = await runCapturingProgress({
      ...base,
      inputType: 'http',
      inputUrls: [],
    } as never)
    expect(urls.result.response).toBe('done')
    expect(urls.result.processedFiles).toBe(0)
  })

  it('surfaces per-file mapping results through the progress stream', async () => {
    const { inputDir, outputDir } = workspace()
    await writeSynthFile(join(inputDir, 'study', 'subject', 'only.dcm'), {
      ...VALID_CT_IMAGE,
      tags: { PatientID: 'INTEGRATION-PID' },
    })

    const { result, progress } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, integrationSpec()),
    )

    expect(result.response).toBe('done')

    const perFile = progress.flatMap((m) =>
      m.response === 'progress' && m.mapResults ? [m.mapResults] : [],
    )
    expect(perFile).toHaveLength(1)
    const mapped = perFile[0]
    expect(mapped?.errors ?? []).toEqual([])

    // The source filename is deliberately NOT preserved. With de-identification
    // off and the output path differing from the input path, collectMappings
    // renames the leaf to `<Modality>_<sourceInstanceUID>.dcm` so that
    // restructuring two trees into one cannot collide. The 'subject' segment
    // confirms getFilePathComp resolved against the right path component.
    expect(mapped?.outputFilePath).toBe(
      `curated/subject/CT_${mapped?.sourceInstanceUID}.dcm`,
    )

    // The same result is also accumulated into the terminal message, so a
    // consumer can rely on either path.
    expect(result.mapResultsList).toHaveLength(1)
    expect(result.mapResultsList?.[0]?.outputFilePath).toBe(
      mapped?.outputFilePath,
    )
  })
})
