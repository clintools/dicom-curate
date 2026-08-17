/**
 * Direct CSV-load mapping (`additionalData.type: 'load'`) driven through
 * `curateMany` — a caller-supplied `table` joined per file.
 *
 * NOT the two-pass flow: that is `type: 'listing'`, which derives its mapping
 * from a first read-only pass.
 *
 * `applyMappingsWorker.test.ts` already exercises the mapping worker against a
 * real worker, but one file per run — so it cannot detect mis-attribution. The
 * property that matters here is that a multi-file join keeps each row bound to
 * its own file when several workers process the batch concurrently.
 */
import {
  csvMappingSpec,
  integrationOptions,
  listFilesRecursive,
  runCapturingProgress,
  useWorkspaces,
  writeImages,
} from '../testutils/integrationHarness'

/** Target ids this suite maps onto; source ids come from `writeImages`. */
const mappedId = (i: number) => `NEW-${String(i).padStart(4, '0')}`

describe('direct CSV-load mapping through real workers', () => {
  const workspace = useWorkspaces()

  it('binds each CSV row to its own file across a concurrent batch', async () => {
    const { inputDir, outputDir } = workspace()
    const count = 12
    const written = await writeImages(inputDir, count)

    const table = written.map((w, i) => ({
      oldId: w.patientId,
      newId: mappedId(i),
    }))

    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, csvMappingSpec(), {
        workerCount: 3,
        table,
      }),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(count)

    const results = result.mapResultsList ?? []
    expect(results).toHaveLength(count)
    for (const r of results) {
      expect(r.errors ?? []).toEqual([])
    }

    // The join must be per-file: every source id maps to its own new id, and
    // concurrency must not shuffle rows between files.
    //
    // Keyed on fileInfo.name because a result's `from` and `to` both come from
    // the same parser — comparing them to each other passes even when the
    // result is attributed to the wrong file.
    const expected = new Map(
      written.map((w, i) => [w.name, { from: w.patientId, to: mappedId(i) }]),
    )
    const actual = new Map(
      results.map((r) => {
        const mapping = r.mappings?.PatientID
        return [r.fileInfo?.name, { from: mapping?.[0], to: mapping?.[3] }]
      }),
    )
    expect(actual).toEqual(expected)
  })

  it('fails only the unmapped files and still writes the mapped ones', async () => {
    const { inputDir, outputDir } = workspace()
    const count = 6
    const mappedCount = 4
    const written = await writeImages(inputDir, count)

    const table = written.slice(0, mappedCount).map((w, i) => ({
      oldId: w.patientId,
      newId: mappedId(i),
    }))

    const { result } = await runCapturingProgress(
      integrationOptions(inputDir, outputDir, csvMappingSpec(), {
        workerCount: 2,
        table,
      }),
    )

    const results = result.mapResultsList ?? []
    expect(results).toHaveLength(count)

    const failed = results.filter((r) => (r.errors ?? []).length > 0)
    const succeeded = results.filter((r) => (r.errors ?? []).length === 0)

    // Which files failed, not just how many: the unmapped ones and only those.
    const names = (rs: typeof results) => rs.map((r) => r.fileInfo?.name).sort()
    expect(names(succeeded)).toEqual(
      written
        .slice(0, mappedCount)
        .map((w) => w.name)
        .sort(),
    )
    expect(names(failed)).toEqual(
      written
        .slice(mappedCount)
        .map((w) => w.name)
        .sort(),
    )

    // Partial coverage is a per-file failure, not a run failure.
    expect(result.response).toBe('done')
    for (const r of failed) {
      expect(r.errors.join(' ')).toMatch(/No row for/)
      // Falsy rather than undefined: a mapping failure leaves outputFilePath as
      // '' here, whereas a scan read failure leaves it undefined. Either way
      // nothing is written — asserted on disk below, which is the guarantee
      // that actually matters.
      expect(r.outputFilePath).toBeFalsy()
    }
    for (const r of succeeded) {
      expect(r.mappings?.PatientID?.[3]).toMatch(/^NEW-\d{4}$/)
    }

    expect(listFilesRecursive(outputDir)).toHaveLength(mappedCount)
  })
})
