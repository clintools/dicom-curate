/**
 * File size: peak memory must not track the size of the file being curated.
 * `curateOne` streams a `LazyFileBlob` so a large instance is never resident in
 * one piece; a regression to `readFile()` is invisible to every other suite.
 *
 * In-process rather than through `curateMany`: a worker's RSS is not observable
 * from the main thread, and file size does not change the worker protocol.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { streamLargeImage } from 'dicom-synth'
import { runPassthroughCurate } from '../conformance/helpers'
import { MIB, measurePeakRssOverhead, mib } from '../testutils/memory'
import { createWorkspace, type Workspace } from '../testutils/workspace'

const SMALL_MIB = 4

/**
 * A realistic large instance, far enough from `SMALL_MIB` that sampling noise
 * cannot fake the slope. Override with `SCALE_LARGE_FILE_MIB`.
 */
const LARGE_MIB = Number(process.env.SCALE_LARGE_FILE_MIB ?? 64)

/**
 * Peak memory growth as a fraction of file-size growth. Streaming scores about
 * -0.03, buffering with `readFileSync` 4.8. A slope, not an absolute ceiling,
 * so it does not encode this machine's baseline RSS.
 */
const MAX_MEMORY_SLOPE = 0.5

/** Throws on a failed curation, which would otherwise score as flat memory. */
async function curateMeasuringPeakRss(dicomPath: string, outDir: string) {
  const { peakOverheadBytes } = await measurePeakRssOverhead(() =>
    runPassthroughCurate(dicomPath, outDir),
  )
  return { inputBytes: statSync(dicomPath).size, peakOverheadBytes }
}

describe('curateOne memory against file size', () => {
  let workspace: Workspace

  beforeAll(() => {
    workspace = createWorkspace('dicom-curate-scale-size-')
  })

  afterAll(() => {
    workspace?.cleanup()
  })

  /** Streamed to disk, so writing the fixture does not put it in memory. */
  function writeFixture(sizeMib: number, seed: number): string {
    const path = join(workspace.inputDir, `${sizeMib}-mib.dcm`)
    streamLargeImage(path, { targetBytes: sizeMib * MIB, modality: 'CT', seed })
    return path
  }

  it('does not grow peak memory in proportion to input size', async () => {
    const smallPath = writeFixture(SMALL_MIB, 1)
    const largePath = writeFixture(LARGE_MIB, 2)

    const small = await curateMeasuringPeakRss(smallPath, workspace.outputDir)
    const large = await curateMeasuringPeakRss(largePath, workspace.outputDir)

    expect(large.inputBytes).toBeGreaterThan(small.inputBytes * 2)

    const slope =
      (large.peakOverheadBytes - small.peakOverheadBytes) /
      (large.inputBytes - small.inputBytes)

    console.log(
      `peak RSS overhead: ${mib(small.inputBytes)} file -> ${mib(small.peakOverheadBytes)}, ` +
        `${mib(large.inputBytes)} file -> ${mib(large.peakOverheadBytes)} (slope ${slope.toFixed(3)})`,
    )

    expect(slope).toBeLessThan(MAX_MEMORY_SLOPE)
  })
})
