import { sample } from '../../testdata/sample'
import collectMappings from '../collectMappings'
import { composeSpecs } from '../composeSpecs'
import type { TMappingOptions } from '../types'
import { sampleSummaryCurationSpecification } from './sampleSummaryCurationSpecification'

describe('sampleSummaryCurationSpecification', () => {
  it('declares listing output and omits mapping (summary-table shape)', () => {
    const spec = composeSpecs(sampleSummaryCurationSpecification())

    expect(spec.additionalData?.type).toBe('listing')
    // No CSV mapping -> consumers run single-pass summary mode.
    expect(spec.additionalData?.mapping).toBeUndefined()

    const additionalData = spec.additionalData as {
      type: 'listing'
      output?: { path: string; rowKey: string }
    }
    expect(additionalData.output).toEqual({
      path: 'reports/series_summary.csv',
      rowKey: 'PerSeries',
    })
  })

  it('output.rowKey is a key of the lookups returned by collect()', () => {
    const spec = composeSpecs(sampleSummaryCurationSpecification())
    const additionalData = spec.additionalData as {
      type: 'listing'
      output: { rowKey: string }
      collect: (parser: {
        getDicom: (n: string) => any
        getFilePathComp: (c: string | number | symbol) => string
        getFrom: (s: string, i: string) => string | number
      }) => { lookups: Record<string, string> }
    }

    const dummyParser = {
      getDicom: () => '',
      getFilePathComp: () => '',
      getFrom: () => '',
    }
    const { lookups } = additionalData.collect(dummyParser)

    expect(Object.keys(lookups)).toContain(additionalData.output.rowKey)
  })

  it('produces a listing carrying lookups and the list-mode info marker', () => {
    const mappingOptions: TMappingOptions = {
      curationSpec: sampleSummaryCurationSpecification,
      skipModifications: true,
    }

    const [, mapResults] = collectMappings(
      'FolderX/FolderY/test.dcm',
      sample,
      mappingOptions,
    )

    expect(mapResults.listing).toBeDefined()
    // rowKey lookup is present on every listing row.
    expect(mapResults.listing!.lookups).toHaveProperty('PerSeries')

    const labels = mapResults.listing!.info.map((entry) => entry[0])
    expect(labels).toEqual([
      'StudyInstanceUID',
      'SeriesInstanceUID',
      'SeriesDescription',
      'FolderX',
      'FolderY',
      'SOPInstanceUIDs',
    ])

    // FolderX / FolderY come from the input path components.
    const folderX = mapResults.listing!.info.find((e) => e[0] === 'FolderX')
    const folderY = mapResults.listing!.info.find((e) => e[0] === 'FolderY')
    expect(folderX?.[1]).toBe('FolderX')
    expect(folderY?.[1]).toBe('FolderY')

    // SOPInstanceUIDs retains its 'list' aggregation marker downstream.
    const sop = mapResults.listing!.info.find((e) => e[0] === 'SOPInstanceUIDs')
    expect(sop?.[2]).toBe('list')
  })
})
