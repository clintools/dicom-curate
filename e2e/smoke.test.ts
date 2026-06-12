/**
 * End-to-end smoke tests: real scan + mapping workers, disk I/O, no mocks.
 * Requires `pnpm build:esm` (see package.json `test:e2e`).
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { curateMany } from 'dicom-curate'
import {
  cleanupTestDicomDir,
  createTestDicomDir,
} from '../testutils/dicomFixtures'
import {
  writeFakeDicomSignatureFile,
  writeMinimalDicomFile,
  writeNonDicomFile,
} from '../testutils/minimalDicom'
import {
  assertInputOutputDisjoint,
  baseCurateOptions,
  createWorkspace,
  flatSmokeSpec,
  hashDirectoryFiles,
  listFilesRecursive,
  pathOrganizedSmokeSpec,
  ps315SmokeSpec,
} from './helpers'

describe('E2E smoke: curateMany', () => {
  const workspaces: Array<() => void> = []
  const fixtureDirs: string[] = []

  afterEach(() => {
    for (const cleanup of workspaces.splice(0)) {
      cleanup()
    }
    for (const dir of fixtureDirs.splice(0)) {
      cleanupTestDicomDir(dir)
    }
  })

  it('processes a single valid DICOM and leaves the source unchanged', async () => {
    const { inputDir, outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)

    const srcPath = join(inputDir, 'study', 'subject', 'instance.dcm')
    writeMinimalDicomFile(srcPath)
    const beforeInput = hashDirectoryFiles(inputDir)

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(1)
    expect(result.mapResultsList).toHaveLength(1)
    expect(result.mapResultsList?.[0]?.errors ?? []).toEqual([])

    const outputs = listFilesRecursive(outputDir)
    expect(outputs.some((p) => p.endsWith('.dcm'))).toBe(true)
    expect(outputs.some((p) => p.split(sep).includes('curated'))).toBe(true)

    expect(hashDirectoryFiles(inputDir)).toEqual(beforeInput)
  })

  it('processes multiple DICOM files in an organized input tree', async () => {
    const batchDir = createTestDicomDir(3, {
      subdirName: 'SERIES-A',
      studyDescription: 'E2E batch',
    })
    fixtureDirs.push(batchDir)

    const { outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)
    assertInputOutputDisjoint(batchDir, outputDir)

    const beforeInput = hashDirectoryFiles(batchDir)

    const result = await curateMany(
      baseCurateOptions(batchDir, outputDir, flatSmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(3)
    expect(result.mapResultsList).toHaveLength(3)

    const dcmOutputs = listFilesRecursive(outputDir).filter((p) =>
      p.endsWith('.dcm'),
    )
    expect(dcmOutputs).toHaveLength(3)

    expect(hashDirectoryFiles(batchDir)).toEqual(beforeInput)
  })

  it('completes with zero processed files for an empty input directory', async () => {
    const { inputDir, outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles ?? 0).toBe(0)
    expect(result.mapResultsList ?? []).toHaveLength(0)
    expect(listFilesRecursive(outputDir)).toHaveLength(0)
  })

  it('runs PS3.15 de-identification on a valid DICOM via the built pipeline', async () => {
    const { inputDir, outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)

    writeMinimalDicomFile(join(inputDir, 'study', 'subject', 'instance.dcm'), {
      patientId: 'E2E-PS315-PATIENT',
    })

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, ps315SmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBe(1)
    expect(result.mapResultsList?.[0]?.errors ?? []).toEqual([])
    expect(
      listFilesRecursive(outputDir).filter((p) => p.endsWith('.dcm')),
    ).toHaveLength(1)
  })

  it('delivers progress callbacks through completion', async () => {
    const { inputDir, outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)

    writeMinimalDicomFile(join(inputDir, 'study', 'subject', 'instance.dcm'))
    const progressMessages: Array<{ response?: string }> = []

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
      (msg) => {
        progressMessages.push(msg)
      },
    )

    expect(result.response).toBe('done')
    expect(progressMessages.some((m) => m.response === 'done')).toBe(true)
  })

  it('records scan anomalies for invalid files without mutating inputs', async () => {
    const { inputDir, outputDir, cleanup } = createWorkspace()
    workspaces.push(cleanup)

    writeMinimalDicomFile(join(inputDir, 'study', 'subject', 'valid.dcm'))
    writeNonDicomFile(join(inputDir, 'study', 'subject', 'notes.txt'))
    writeFakeDicomSignatureFile(
      join(inputDir, 'study', 'subject', 'bad_sig.dcm'),
    )

    const beforeInput = hashDirectoryFiles(inputDir)

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBeGreaterThanOrEqual(1)

    const withAnomalies = (result.mapResultsList ?? []).filter(
      (r) => r.anomalies && r.anomalies.length > 0,
    )
    expect(withAnomalies.length).toBeGreaterThanOrEqual(2)

    const validResult = (result.mapResultsList ?? []).find((r) =>
      r.outputFilePath?.includes('valid.dcm'),
    )
    expect(validResult?.errors ?? []).toEqual([])

    expect(
      listFilesRecursive(outputDir).filter((p) => p.endsWith('.dcm')),
    ).toHaveLength(1)
    expect(hashDirectoryFiles(inputDir)).toEqual(beforeInput)
  })

  // Permission checks are bypassed for root (e.g. some CI containers), so the
  // EACCES setup below cannot fail there.
  it.skipIf(process.getuid?.() === 0)(
    'continues past a real unreadable file and keeps its path out of errors and UID',
    async () => {
      const { inputDir, outputDir, cleanup } = createWorkspace()

      writeMinimalDicomFile(join(inputDir, 'study', 'subject', 'valid.dcm'))

      // A directory with read-but-no-execute permission: readdir can list the
      // file (so the feeder sees it), but fs.stat fails with EACCES — a real
      // filesystem read failure whose raw message contains the full path.
      const lockedDir = join(inputDir, 'study', 'locked-subject')
      mkdirSync(lockedDir, { recursive: true })
      writeMinimalDicomFile(join(lockedDir, 'secret-patient.dcm'))
      chmodSync(lockedDir, 0o666)
      // Restore permissions before cleanup, even on assertion failure —
      // rmSync cannot remove contents of a no-execute directory.
      workspaces.push(() => {
        chmodSync(lockedDir, 0o755)
        cleanup()
      })

      const result = await curateMany(
        baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
      )

      // The run completes despite the unreadable file, and the readable file
      // is fully processed.
      expect(result.response).toBe('done')
      const validResult = (result.mapResultsList ?? []).find((r) =>
        r.outputFilePath?.includes('valid.dcm'),
      )
      expect(validResult?.errors ?? []).toEqual([])

      const readErrorResults = (result.mapResultsList ?? []).filter(
        (r) => r.sourceInstanceUID?.startsWith('scan_') && r.errors?.length,
      )
      expect(readErrorResults).toHaveLength(1)
      const readError = readErrorResults[0]

      // The error string carries the failure code but neither the filename
      // nor any path segment — node fs errors embed the full path in
      // error.message, which must never reach this server-bound field.
      expect(readError.errors[0]).toBe(
        'Unable to read file (filesystem error): EACCES',
      )

      // The synthetic UID must not encode the filename either.
      expect(readError.sourceInstanceUID).not.toContain('secret')
      expect(readError.sourceInstanceUID).toMatch(/^scan_[0-9a-f]{16}$/)

      // No output path (nothing was written), but fileInfo retains the real
      // name/path for the private (input) log.
      expect(readError.outputFilePath).toBeUndefined()
      expect(readError.fileInfo?.name).toBe('secret-patient.dcm')
      expect(readError.fileInfo?.path).toContain('locked-subject')
    },
  )
})
