/**
 * End-to-end smoke tests: real scan + mapping workers, disk I/O, no mocks.
 * Requires `pnpm build:esm` (see package.json `test:e2e`).
 */
import { join } from 'node:path'
import {
  cleanupTestDicomDir,
  createTestDicomDir,
} from '../testutils/dicomFixtures'
import {
  writeFakeDicomSignatureFile,
  writeMinimalDicomFile,
  writeNonDicomFile,
} from '../testutils/minimalDicom'
import { curateMany } from 'dicom-curate'
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
    expect(result.mapResultsList![0].errors).toEqual([])

    const outputs = listFilesRecursive(outputDir)
    expect(outputs.some((p) => p.endsWith('.dcm'))).toBe(true)
    expect(outputs.some((p) => p.includes('curated/'))).toBe(true)

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
    expect(result.processedFiles).toBe(0)
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
    expect(result.mapResultsList![0].errors).toEqual([])
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
    writeFakeDicomSignatureFile(join(inputDir, 'study', 'subject', 'bad_sig.dcm'))

    const beforeInput = hashDirectoryFiles(inputDir)

    const result = await curateMany(
      baseCurateOptions(inputDir, outputDir, pathOrganizedSmokeSpec()),
    )

    expect(result.response).toBe('done')
    expect(result.processedFiles).toBeGreaterThanOrEqual(1)

    const withAnomalies = result.mapResultsList!.filter(
      (r) => r.anomalies && r.anomalies.length > 0,
    )
    expect(withAnomalies.length).toBeGreaterThanOrEqual(2)

    const anomalyText = withAnomalies.flatMap((r) => r.anomalies).join('\n')
    expect(anomalyText).toMatch(/DICOM signature|very small|not.*dicom/i)

    const validResult = result.mapResultsList!.find((r) =>
      r.outputFilePath?.includes('valid.dcm'),
    )
    expect(validResult?.errors ?? []).toEqual([])

    expect(
      listFilesRecursive(outputDir).filter((p) => p.endsWith('.dcm')),
    ).toHaveLength(1)
    expect(hashDirectoryFiles(inputDir)).toEqual(beforeInput)
  })
})
