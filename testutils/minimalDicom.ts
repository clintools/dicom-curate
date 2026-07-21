import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as dcmjs from 'dcmjs'

export function writeMinimalDicomFile(
  filePath: string,
  tags?: {
    patientId?: string
    patientName?: string
    sopInstanceUid?: string
  },
): void {
  const patientId = tags?.patientId ?? 'TEST-PATIENT-001'
  const patientName = tags?.patientName ?? 'TEST^PATIENT'
  const sopUID = tags?.sopInstanceUid ?? '1.2.3.4.5.6.7.8.9.0.1'

  const dataset: Record<string, unknown> = {
    PatientName: patientName,
    PatientID: patientId,
    Modality: 'CT',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    SOPInstanceUID: sopUID,
    SeriesInstanceUID: '1.2.3.4.5.6.7.8',
    StudyInstanceUID: '1.2.3.4.5.6.7',
    SeriesNumber: '1',
    Rows: 1,
    Columns: 1,
    BitsAllocated: 16,
    PixelRepresentation: 0,
    PixelData: new Uint8Array([0, 0]).buffer,
  }

  const dicomDict = new dcmjs.data.DicomDict({})
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
  const buffer = dicomDict.write({ allowInvalidVRLength: true })
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, Buffer.from(buffer))
}

export const DICOMDIR_SOP_CLASS_UID = '1.2.840.10008.1.3.10'

/**
 * A DICOMDIR that dcmjs can parse, so it reaches `preExclude`.
 *
 * MediaStorageSOPClassUID must be written into the meta group explicitly —
 * dcmjs does not derive it from the dataset's SOPClassUID.
 */
export function buildDicomdirDcmjsBuffer(): ArrayBuffer {
  const dicomDict = new dcmjs.data.DicomDict({
    '00020002': { vr: 'UI', Value: [DICOMDIR_SOP_CLASS_UID] },
    '00020003': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9'] },
    '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
  })
  // Basic Directory IOD: an empty file-set is still a valid DICOMDIR.
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset({
    FileSetID: 'TESTFS',
    DirectoryRecordSequence: [],
  })
  return dicomDict.write({ allowInvalidVRLength: true })
}

export function writeNonDicomFile(
  filePath: string,
  content = 'not dicom',
): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

/** File large enough to pass size check but without DICM at offset 128. */
export function writeFakeDicomSignatureFile(filePath: string): void {
  const buf = Buffer.alloc(200, 0)
  buf.write('XXXX', 128, 4, 'ascii')
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, buf)
}
