import * as dcmjs from 'dcmjs'
import { sample } from '../testdata/sample'
import collectMappings from './collectMappings'
import type { TMappingOptions } from './types'

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
