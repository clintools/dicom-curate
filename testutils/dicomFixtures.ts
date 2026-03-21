/**
 * Reusable DICOM test fixture utilities.
 *
 * Creates minimal but valid DICOM files on disk for use in integration tests
 * that exercise the full curateMany pipeline (scan → dispatch → map → done).
 *
 * Usage:
 *   const dir = await createTestDicomDir(5)
 *   // ... run curateMany with inputType: 'path', inputDirectory: dir
 *   await cleanupTestDicomDir(dir)
 */

import * as dcmjs from 'dcmjs'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Create a temporary directory containing `count` minimal valid DICOM files.
 * Each file has unique UIDs so the scan worker treats them as distinct.
 *
 * @param count Number of DICOM files to create
 * @param options Optional overrides for DICOM tags
 * @returns Absolute path to the created directory
 */
export function createTestDicomDir(
  count: number,
  options?: {
    /** Patient name shared across all files. Default: 'TEST^PATIENT' */
    patientName?: string
    /** Study description. Default: 'Crash Recovery Test' */
    studyDescription?: string
    /** Subdirectory name for files (not a full path). Default: 'TEST-001' */
    subdirName?: string
  },
): string {
  const patientName = options?.patientName ?? 'TEST^PATIENT'
  const studyDescription = options?.studyDescription ?? 'Crash Recovery Test'
  const subdirName = options?.subdirName ?? 'TEST-001'

  const baseDir = join(tmpdir(), `dicom-curate-test-${Date.now()}`)
  const filesDir = join(baseDir, subdirName)
  mkdirSync(filesDir, { recursive: true })

  // Generate a base UID prefix (valid DICOM UID root)
  const uidBase = '2.25.99999'
  const studyUID = `${uidBase}.1.${Date.now()}`

  for (let i = 0; i < count; i++) {
    const seriesUID = `${uidBase}.2.${Date.now()}.${i}`
    const sopUID = `${uidBase}.3.${Date.now()}.${i}`

    const dataset: Record<string, any> = {
      // Patient
      '00100010': { vr: 'PN', Value: [{ Alphabetic: patientName }] },
      '00100020': { vr: 'LO', Value: ['TEST-PATIENT-001'] },
      // Study
      '0020000D': { vr: 'UI', Value: [studyUID] },
      '00081030': { vr: 'LO', Value: [studyDescription] },
      // Series
      '0020000E': { vr: 'UI', Value: [seriesUID] },
      '00080060': { vr: 'CS', Value: ['CT'] },
      // Instance
      '00080018': { vr: 'UI', Value: [sopUID] },
      '00080016': {
        vr: 'UI',
        Value: ['1.2.840.10008.5.1.4.1.1.2'], // CT Image Storage
      },
      // Minimal image data (1x1 pixel)
      '00280010': { vr: 'US', Value: [1] }, // Rows
      '00280011': { vr: 'US', Value: [1] }, // Columns
      '00280100': { vr: 'US', Value: [16] }, // BitsAllocated
      '00280103': { vr: 'US', Value: [0] }, // PixelRepresentation
      '7FE00010': {
        vr: 'OW',
        Value: [new Uint8Array([0x00, 0x00]).buffer],
      },
    }

    const dicomDict = new dcmjs.data.DicomDict({})
    dicomDict.dict = dataset
    const buffer = dicomDict.write()

    const filename = `test_${String(i).padStart(4, '0')}.dcm`
    writeFileSync(join(filesDir, filename), Buffer.from(buffer))
  }

  return baseDir
}

/**
 * Remove a test DICOM directory created by createTestDicomDir.
 */
export function cleanupTestDicomDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
