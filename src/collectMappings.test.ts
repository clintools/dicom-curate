import * as dcmjs from 'dcmjs'
import { sample } from '../testdata/sample'
import collectMappings from './collectMappings'
import type { TCurationSpecification, TMappingOptions } from './types'

// A minimal spec that maps input path 'study/subject/test.dcm' to the same
// output path, so no filename replacement occurs and outputFilePath is predictable.
function makeSpec(
  overrides: Partial<TCurationSpecification> = {},
): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    inputPathPattern: 'study/subject',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: () => ['study', 'subject', 'test.dcm'],
    errors: () => [],
    ...overrides,
  })
}

describe('collectMappings with none specification', () => {
  it('returns early with naturalized dataset and empty map results', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: 'none',
    }

    const [naturalData, mapResults] = collectMappings(
      'some/input/file.dcm',
      sample,
      mappingOptions,
    )

    const expectedNaturalData =
      dcmjs.data.DicomMetaDictionary.naturalizeDataset(sample.dict)

    expect(naturalData).toEqual(expectedNaturalData)
    expect(mapResults).toEqual({
      sourceInstanceUID: '',
      outputFilePath: '',
      mappings: {},
      anomalies: [],
      errors: [],
      quarantine: {},
    })
  })

  it('does not require function-style curation spec details in none mode', () => {
    const mappingOptions = {
      curationSpec: 'none',
      // missing fields that would otherwise be used on the non-none branch
      columnMappings: undefined,
      skipValidation: false,
      skipModifications: false,
    } as TMappingOptions

    expect(() =>
      collectMappings('input.dcm', sample, mappingOptions),
    ).not.toThrow()
  })
})

describe('collectMappings preExclude', () => {
  it('sets excluded: pre and returns early when preExclude returns true', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({ preExclude: () => true }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBe('pre')
    expect(mapResults.mappings).toEqual({})
    expect(mapResults.outputFilePath).toBe('')
  })

  it('continues normally when preExclude returns false', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({ preExclude: () => false }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBeUndefined()
    expect(mapResults.outputFilePath).toBe('study/subject/test.dcm')
  })

  it('passes original DICOM tags to preExclude via parser.getDicom', () => {
    let capturedPatientId: string | undefined

    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        preExclude: (parser) => {
          capturedPatientId = parser.getDicom('PatientID')
          return false
        },
      }),
    }

    collectMappings('study/subject/test.dcm', sample, mappingOptions)

    // sample has PatientID '00100020' → 'Test Long String'
    expect(capturedPatientId).toBe('Test Long String')
  })

  it('does not call postExclude when preExclude returns true', () => {
    const postExclude = vi.fn(() => false)

    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({ preExclude: () => true, postExclude }),
    }

    collectMappings('study/subject/test.dcm', sample, mappingOptions)

    expect(postExclude).not.toHaveBeenCalled()
  })
})

describe('collectMappings postExclude', () => {
  it('sets excluded: post and skips header mappings when postExclude returns true', () => {
    const modifyDicomHeader = vi.fn(() => ({ PatientID: 'REPLACED' }))

    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        postExclude: () => true,
        modifyDicomHeader,
      }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBe('post')
    expect(mapResults.mappings).toEqual({})
    expect(modifyDicomHeader).not.toHaveBeenCalled()
  })

  it('continues normally when postExclude returns false', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({ postExclude: () => false }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBeUndefined()
  })

  it('exposes the computed output file path via parser.outputFilePath', () => {
    let capturedPath: string | undefined

    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        outputFilePathComponents: () => ['out', 'dir', 'file.dcm'],
        postExclude: (parser) => {
          capturedPath = parser.outputFilePath
          return false
        },
      }),
    }

    collectMappings('study/subject/test.dcm', sample, mappingOptions)

    // When outputFilePath differs from inputFilePath, the filename segment is
    // replaced with `${modality}_${uid}.dcm`; verify the directory prefix.
    expect(capturedPath).toMatch(/^out\/dir\//)
  })

  it('exposes DICOM tags via parser.getDicom in postExclude', () => {
    let capturedModality: string | undefined

    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        postExclude: (parser) => {
          capturedModality = parser.getDicom('Modality')
          return false
        },
      }),
    }

    collectMappings('study/subject/test.dcm', sample, mappingOptions)

    // sample has Modality '00080060' → 'TEST_CODE'
    expect(capturedModality).toBe('TEST_CODE')
  })
})

describe('collectMappings listing', () => {
  type ListingCollect = (parser: {
    getDicom: (attrName: string) => any
    getFilePathComp: (component: string | number | symbol) => string
    getFrom: (source: string, identifier: string) => string | number
  }) => {
    lookups: { [lookupField: string]: string }
    info: (
      | [name: string, value: string]
      | [name: string, value: string, mode: 'list']
    )[]
    collect: [value: string, format: RegExp | string[], lookupField: string][]
  }

  function listingSpec(collect: ListingCollect): () => TCurationSpecification {
    return () =>
      makeSpec({
        additionalData: {
          type: 'listing',
          collect,
        } as TCurationSpecification['additionalData'],
      })()
  }

  it('emits the full lookups map on the listing', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: listingSpec(() => ({
        lookups: { PerSeries: 'series-1', PerStudy: 'study-1' },
        info: [['Label', 'value']],
        collect: [],
      })),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.listing).toBeDefined()
    expect(mapResults.listing!.lookups).toEqual({
      PerSeries: 'series-1',
      PerStudy: 'study-1',
    })
  })

  it('passes through the optional info aggregation mode marker', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: listingSpec(() => ({
        lookups: { PerSeries: 'series-1' },
        info: [
          ['StudyInstanceUID', 'study-1'],
          ['SOPInstanceUIDs', 'sop-1', 'list'],
        ],
        collect: [],
      })),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.listing!.info).toEqual([
      ['StudyInstanceUID', 'study-1'],
      ['SOPInstanceUIDs', 'sop-1', 'list'],
    ])
  })

  it('preserves the mode marker while flattening single-element PN values', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: listingSpec(() => ({
        lookups: { PerSeries: 'series-1' },
        info: [
          // dcmjs single-element PN array of digits -> flattened to Alphabetic,
          // while the 'list' marker is retained.
          ['PatientID', [{ Alphabetic: '12345' }] as unknown as string, 'list'],
        ],
        collect: [],
      })),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.listing!.info).toEqual([['PatientID', '12345', 'list']])
  })

  it('still resolves collectByValue lookup values', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: listingSpec(() => ({
        lookups: { PerSeries: 'series-1' },
        info: [],
        collect: [['Comment', /.*/, 'PerSeries']],
      })),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    // collectByValue appends lookups[lookupField] as the final tuple element.
    expect(mapResults.listing!.collectByValue).toEqual([
      ['Comment', /.*/, 'PerSeries', 'series-1'],
    ])
  })
})

describe('collectMappings filter error handling', () => {
  it('treats file as included and records error when preExclude throws', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        preExclude: () => {
          throw new Error('boom in preExclude')
        },
      }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBeUndefined()
    expect(mapResults.errors).toContain(
      'preExclude threw an error: boom in preExclude — treating file as included (fail-safe)',
    )
  })

  it('treats file as included and records error when postExclude throws', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: makeSpec({
        postExclude: () => {
          throw new Error('boom in postExclude')
        },
      }),
    }

    const [, mapResults] = collectMappings(
      'study/subject/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.excluded).toBeUndefined()
    expect(mapResults.errors).toContain(
      'postExclude threw an error: boom in postExclude — treating file as included (fail-safe)',
    )
  })
})
