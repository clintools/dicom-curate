import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as dcmjs from 'dcmjs'
import { type FileSpec, generateFile, type ValidImageSpec } from 'dicom-synth'

/**
 * Spread to override tags, e.g.
 * `{ ...VALID_CT_IMAGE, tags: { PatientID: 'OLD-ID' } }`.
 *
 * Modality is pinned because output paths and anomaly messages are asserted
 * against it in several tests.
 */
export const VALID_CT_IMAGE: ValidImageSpec = {
  type: 'valid-image',
  modality: 'CT',
}

/**
 * Exists because dicom-synth has no equivalent: `generateFile` performs no
 * I/O, and `writeCollectionFromSpec` derives its own filenames and layout, so
 * neither can target the caller-chosen paths these tests assert on.
 */
export async function writeSynthFile(
  filePath: string,
  spec: FileSpec,
): Promise<void> {
  const { buffer } = await generateFile(spec)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, buffer)
}

export const DICOMDIR_SOP_CLASS_UID = '1.2.840.10008.1.3.10'

/**
 * A DICOMDIR that dcmjs can parse, so it reaches `preExclude`.
 *
 * MediaStorageSOPClassUID must be written into the meta group explicitly —
 * dcmjs does not derive it from the dataset's SOPClassUID.
 *
 * Hand-built on purpose: dicom-synth's `{ type: 'dicomdir' }` omits the file
 * meta group length, which dcmjs rejects outright. The two are complementary —
 * that fixture exercises the parse-rejection path, this one the exclusion path.
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
