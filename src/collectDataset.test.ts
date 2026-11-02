import * as dcmjs from 'dcmjs'
import { extractDataset } from './collectDataset'
import { curateOne } from './curateOne'
import type {
  TCurationSpecification,
  TFileInfo,
  TMappingOptions,
} from './types'

// Build a minimal but valid DICOM binary from scratch using dcmjs (same pattern as
// curateOne.test.ts "byte-identical output").
function makeDicomBuffer(): ArrayBuffer {
  const dataset = {
    PatientName: 'Test',
    PatientID: 'PAT-42',
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
  return dicomDict.write({ allowInvalidVRLength: true })
}

function makeFileInfo(buffer: ArrayBuffer, name: string): TFileInfo {
  return {
    kind: 'blob',
    blob: new Blob([buffer], { type: 'application/octet-stream' }),
    path: 'input/path',
    name,
    size: buffer.byteLength,
  }
}

describe('extractDataset', () => {
  it('keeps text elements, drops binary VRs, and produces plain JSON', () => {
    const dict = {
      '00080060': { vr: 'CS', Value: ['CT'] },
      '00100010': { vr: 'PN', Value: [{ Alphabetic: 'Doe^Jane' }] },
      '7FE00010': { vr: 'OW', Value: [new ArrayBuffer(16)] },
      '00090010': { vr: 'UN', Value: [new Uint8Array(8)] },
    }
    const out = extractDataset(dict)
    expect(out['00080060']).toEqual({ vr: 'CS', Value: ['CT'] })
    expect(out['00100010']).toEqual({
      vr: 'PN',
      Value: [{ Alphabetic: 'Doe^Jane' }],
    })
    expect(out['7FE00010']).toBeUndefined() // binary VR excluded
    expect(out['00090010']).toBeUndefined() // UN excluded
    // the whole result must survive structured clone / JSON round-trips
    expect(() => structuredClone(out)).not.toThrow()
  })
})

describe('curateOne with collectDataset', () => {
  it("parses and returns the source header in passthrough ('none') mode", async () => {
    const result = await curateOne({
      fileInfo: makeFileInfo(makeDicomBuffer(), 'ct.dcm'),
      outputTarget: {},
      mappingOptions: {
        curationSpec: 'none',
        skipWrite: true,
        collectDataset: true,
      },
    })
    expect(result.dataset).toBeDefined()
    expect(result.dataset!['00100020']).toEqual({ vr: 'LO', Value: ['PAT-42'] })
    expect(result.dataset!['00080060']).toEqual({ vr: 'CS', Value: ['CT'] })
    expect(result.dataset!['7FE00010']).toBeUndefined()
    // passthrough semantics unchanged
    expect(result.mappingRequired).toBe(false)
    expect(result.mappings).toEqual({})
    expect(result.errors).toEqual([])
  })

  it("records an anomaly (and still passes through) for non-DICOM in 'none' mode", async () => {
    const bytes = new TextEncoder().encode('not-a-dicom-file')
    const result = await curateOne({
      fileInfo: makeFileInfo(
        bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer,
        'junk.bin',
      ),
      outputTarget: {},
      mappingOptions: {
        curationSpec: 'none',
        skipWrite: true,
        collectDataset: true,
      },
    })
    expect(result.dataset).toBeUndefined()
    expect(result.anomalies.join(' ')).toContain('collectDataset')
    expect(result.mappingRequired).toBe(false)
  })

  it('returns the PRE-mapping source header alongside a real curation spec', async () => {
    const remapSpec: () => TCurationSpecification = () => ({
      inputPathPattern: 'folder',
      version: '3.0',
      hostProps: {},
      dicomPS315EOptions: 'Off',
      modifyDicomHeader: () => ({ PatientID: 'REMAPPED' }),
      outputFilePathComponents: (parser) => [
        parser.getFilePathComp(parser.FILENAME),
      ],
      errors: () => [],
    })
    const result = await curateOne({
      fileInfo: makeFileInfo(makeDicomBuffer(), 'ct.dcm'),
      outputTarget: {},
      mappingOptions: {
        curationSpec: remapSpec,
        skipWrite: true,
        collectDataset: true,
      } satisfies TMappingOptions,
    })
    // dataset reflects the SOURCE (pre-mapping) header, not the remapped one,
    // while the mapping itself did happen (mappings is non-empty)
    expect(result.dataset).toBeDefined()
    expect(result.dataset!['00100020']).toEqual({ vr: 'LO', Value: ['PAT-42'] })
    expect(Object.keys(result.mappings ?? {}).length).toBeGreaterThan(0)
  })

  it('does not collect a dataset unless asked', async () => {
    const result = await curateOne({
      fileInfo: makeFileInfo(makeDicomBuffer(), 'ct.dcm'),
      outputTarget: {},
      mappingOptions: { curationSpec: 'none', skipWrite: true },
    })
    expect(result.dataset).toBeUndefined()
  })
})
