import type { TCurationSpecification } from '../types'

/*
 * Sample of a summary-table curation specification.
 *
 * This is a single-pass, read-only spec: it declares `additionalData.output`
 * and omits `additionalData.mapping`. Consumers (e.g. MedEx) detect this shape
 * and, instead of writing curated DICOMs, aggregate the per-file `listing`
 * data into a CSV summary table written to `output.path`.
 *
 * One CSV row is emitted per unique value of `lookups[output.rowKey]`
 * (here, per unique SeriesInstanceUID). The CSV columns are the `info`
 * entries, in declaration order:
 *   StudyInstanceUID, SeriesInstanceUID, SeriesDescription,
 *   FolderX, FolderY, SOPInstanceUIDs
 *
 * `info` entries default to first-wins within a row group. The optional third
 * tuple element 'list' aggregates distinct values across the group, joined
 * with ';' (used here for SOPInstanceUIDs so every instance is captured).
 */
export function sampleSummaryCurationSpecification(): TCurationSpecification {
  const hostProps = { protocolNumber: 'Demo' }

  return {
    inputPathPattern: 'any',

    additionalData: {
      type: 'listing',
      collect: (parser) => ({
        lookups: {
          PerSeries: parser.getDicom('SeriesInstanceUID'),
        },
        info: [
          ['StudyInstanceUID', parser.getDicom('StudyInstanceUID')],
          ['SeriesInstanceUID', parser.getDicom('SeriesInstanceUID')],
          ['SeriesDescription', parser.getDicom('SeriesDescription')],
          ['FolderX', parser.getFilePathComp(0)],
          ['FolderY', parser.getFilePathComp(1)],
          ['SOPInstanceUIDs', parser.getDicom('SOPInstanceUID'), 'list'],
        ],
        collect: [],
      }),
      output: {
        path: 'reports/series_summary.csv',
        rowKey: 'PerSeries',
      },
      // No `mapping` => single pass, write CSV summary instead of DICOMs.
    },

    version: '3.0',
    hostProps,

    // No de-identification or header modification in summary mode.
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    // Unused when consumers run with skipModifications.
    outputFilePathComponents: () => [],
    errors: () => [],
  }
}
