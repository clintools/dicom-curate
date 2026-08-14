/**
 * Two-pass CSV mapping (strategy W2) driven through `curateMany`.
 *
 * `applyMappingsWorker.test.ts` already exercises the mapping worker against a
 * real worker, but one file per run — so it cannot detect mis-attribution. The
 * property that matters here is that a multi-file join keeps each row bound to
 * its own file when several workers process the batch concurrently.
 */
import {
  createIntegrationWorkspace,
  csvMappingSpec,
  type IntegrationWorkspace,
  integrationOptions,
  listFilesRecursive,
  runCapturingProgress,
  writeImages,
} from '../testutils/integrationHarness'

/** Target ids this suite maps onto; source ids come from `writeImages`. */
const mappedId = (i: number) => `NEW-${String(i).padStart(4, '0')}`

describe('two-pass CSV mapping through real workers', () => {
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
    const pairs = results
      .map((r) => {
        const mapping = r.mappings?.PatientID
        return { from: mapping?.[0], to: mapping?.[3] }
      })
      .filter((p) => typeof p.from === 'string')
    expect(pairs).toHaveLength(count)

    const expected = new Map(table.map((row) => [row.oldId, row.newId]))
    for (const { from, to } of pairs) {
      expect(to).toBe(expected.get(String(from)))
    }
    // Every row was consumed exactly once — no duplicates, none skipped.
    expect(new Set(pairs.map((p) => p.to)).size).toBe(count)
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

    expect(succeeded).toHaveLength(mappedCount)
    expect(failed).toHaveLength(count - mappedCount)

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
