import * as dcmjs from 'dcmjs'
import { jest } from '@jest/globals'
import { curateOne } from './curateOne'
import type {
  TFileInfo,
  TMappingOptions,
  TCurationSpecification,
} from './types'

describe('curateOne with none specification', () => {
  it('returns passthrough mapping results and skips DICOM parsing', async () => {
    const bytes = new TextEncoder().encode('not-a-dicom-file')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([bytes], { type: 'application/octet-stream' }),
      path: 'input/path',
      name: 'my test!.dcm',
      size: bytes.length,
    }

    const mappingOptions: TMappingOptions = {
      curationSpec: 'none',
      skipWrite: true,
    }

    const readFileSpy = jest.spyOn(dcmjs.data.DicomMessage, 'readFile')

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions,
    })

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(result.mappingRequired).toBe(false)
    expect(result.sourceInstanceUID).toContain('passthrough')
    expect(result.outputFilePath).toBe('input/path/my test!.dcm')
    expect(result.mappings).toEqual({})
    expect(result.anomalies).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.quarantine).toEqual({})
  })

  it('preserves bytes in passthrough mode when producing mappedBlob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 255])
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([bytes], { type: 'application/octet-stream' }),
      path: 'input',
      name: 'raw.bin',
      size: bytes.length,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: 'none', skipWrite: false },
    })

    const mappedBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    expect(Array.from(mappedBytes)).toEqual(Array.from(bytes))
    expect(result.mappingRequired).toBe(false)
  })
})

describe('curateOne byte-identical output when no header changes', () => {
  // A spec that parses the file but makes no DICOM header modifications:
  // de-identification is Off and modifyDicomHeader returns {}.
  const noOpSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  it('preserves original bytes when spec produces no DICOM header mappings', async () => {
    // Build a minimal but valid DICOM binary from scratch using dcmjs
    const dataset = {
      PatientName: 'Test',
      PatientID: 'P001',
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    const originalBuffer = dicomDict.write({ allowInvalidVRLength: true })
    const originalBytes = new Uint8Array(originalBuffer)

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([originalBuffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: originalBytes.length,
    }

    const mappingOptions: TMappingOptions = {
      curationSpec: noOpSpec,
      skipWrite: false,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions,
    })

    // The output should be byte-identical to the input
    const mappedBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    expect(Array.from(mappedBytes)).toEqual(Array.from(originalBytes))

    // Mapping was still evaluated (not skipped like canSkip or 'none')
    expect(result.mappingRequired).toBe(true)
    expect(Object.keys(result.mappings!)).toHaveLength(0)
  })
})
