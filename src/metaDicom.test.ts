import type { TDicomData } from 'dcmjs'
import { DICOMDIR_SOP_CLASS_UID } from '../testutils/minimalDicom'
import collectMappings from './collectMappings'
import type { TCurationSpecification, TMappingOptions, TParser } from './types'

const CT_IMAGE_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.2'

function makeSpec(
  preExclude?: (parser: TParser) => boolean,
): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    inputPathPattern: 'study/subject',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: () => ['study', 'subject', 'test.dcm'],
    errors: () => [],
    ...(preExclude ? { preExclude } : {}),
  })
}

/** A DICOMDIR declares its SOP class only in the file meta group. */
function dicomdirData(): TDicomData {
  return {
    meta: {
      '00020002': { vr: 'UI', Value: [DICOMDIR_SOP_CLASS_UID] },
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    },
    dict: {
      '00041130': { vr: 'CS', Value: ['TESTFS'] },
      '00041220': { vr: 'SQ', Value: [] },
    },
  } as unknown as TDicomData
}

function imageData(): TDicomData {
  return {
    meta: {
      '00020002': { vr: 'UI', Value: [CT_IMAGE_SOP_CLASS_UID] },
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    },
    dict: {
      '00080016': { vr: 'UI', Value: [CT_IMAGE_SOP_CLASS_UID] },
      '00080060': { vr: 'CS', Value: ['CT'] },
    },
  } as unknown as TDicomData
}

function run(
  data: TDicomData,
  preExclude?: (parser: TParser) => boolean,
  inputFilePath = 'study/subject/test.dcm',
  skipWrite = false,
) {
  const mappingOptions: TMappingOptions = {
    curationSpec: makeSpec(preExclude),
    skipWrite,
  }
  return collectMappings(inputFilePath, data, mappingOptions)
}

const excludeDicomdir = (parser: TParser) =>
  parser.getMetaDicom('MediaStorageSOPClassUID') === DICOMDIR_SOP_CLASS_UID

describe('parser.getMetaDicom', () => {
  it('reads a tag from the file meta group', () => {
    let seen: string | undefined
    run(dicomdirData(), (parser) => {
      seen = parser.getMetaDicom('MediaStorageSOPClassUID')
      return false
    })
    expect(seen).toBe(DICOMDIR_SOP_CLASS_UID)
  })

  it('accepts a hex tag key', () => {
    let seen: string | undefined
    run(dicomdirData(), (parser) => {
      seen = parser.getMetaDicom('(0002,0002)')
      return false
    })
    expect(seen).toBe(DICOMDIR_SOP_CLASS_UID)
  })

  it('does not expose meta tags through getDicom', () => {
    // getDicom sees the dataset only — this is why getMetaDicom exists.
    let seen: unknown
    run(dicomdirData(), (parser) => {
      seen = parser.getDicom('MediaStorageSOPClassUID')
      return false
    })
    expect(seen).toBeUndefined()
  })

  it('returns undefined when the meta group is absent', () => {
    const noMeta = { dict: imageData().dict } as unknown as TDicomData
    let seen: string | undefined
    expect(() =>
      run(noMeta, (parser) => {
        seen = parser.getMetaDicom('MediaStorageSOPClassUID')
        return false
      }),
    ).not.toThrow()
    expect(seen).toBeUndefined()
  })
})

describe('preExclude driven by media storage SOP class', () => {
  it('excludes a DICOMDIR', () => {
    const [, mapResults] = run(dicomdirData(), excludeDicomdir)
    expect(mapResults.excluded).toBe('pre')
  })

  it('does not exclude an ordinary image instance', () => {
    const [, mapResults] = run(imageData(), excludeDicomdir)
    expect(mapResults.excluded).toBeUndefined()
  })

  it('records the excluded file by name, without the path', () => {
    const [, mapResults] = run(
      dicomdirData(),
      excludeDicomdir,
      'study/subject/test.dcm',
    )
    const anomaly = mapResults.anomalies.join(' ')
    expect(anomaly).toContain('test.dcm')
    expect(anomaly).not.toContain('study/subject')
  })

  it('still excludes but emits no anomaly on the form-generation pass', () => {
    // collectMappings runs on both the skipWrite (form-generation) pass and the
    // write pass; the exclusion anomaly is emitted only on the write pass so
    // consumers do not double-count the file.
    const [, mapResults] = run(
      dicomdirData(),
      excludeDicomdir,
      'study/subject/test.dcm',
      true,
    )
    expect(mapResults.excluded).toBe('pre')
    expect(mapResults.anomalies).toEqual([])
  })
})
