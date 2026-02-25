/**
 * Example curation spec for the CLI. Use as reference or pass with: -s cli/curation-spec.js
 * This pattern expects input files in: <input-dir>/<patient>/<study>/<series>/<file.dcm>
 */
export default () => ({
  version: '3.0',
  inputPathPattern: 'patient/study/series/file',
  modifyDicomHeader(parser) {
    return {
      PatientName: parser.getFilePathComp('patient'),
      PatientID: parser.getFilePathComp('patient'),
      StudyDescription: parser.getFilePathComp('study'),
      SeriesDescription: parser.getFilePathComp('series'),
    }
  },
  outputFilePathComponents(parser) {
    return [
      parser.getDicom('PatientID'),
      parser.getDicom('StudyDescription'),
      parser.getDicom('SeriesDescription'),
      parser.getFilePathComp(parser.FILEBASENAME) + '.dcm',
    ]
  },
})
