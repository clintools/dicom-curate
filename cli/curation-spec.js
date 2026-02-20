export default () => ({
  version: '3.0',
  // This pattern expects input files to be in a structure like:
  // <input-directory>/<patient>/<study>/<series>/<file.dcm>
  inputPathPattern: 'patient/study/series/file',
  modifyDicomHeader(parser) {
    return {
      PatientName: parser.getFilePathComp('patient'),
      PatientID: parser.getFilePathComp('patient'),
      StudyDescription: parser.getFilePathComp('study'),
      SeriesDescription: parser.getFilePathComp('series'),
    };
  },
  outputFilePathComponents(parser) {
    return [
      parser.getDicom('PatientID'),
      parser.getDicom('StudyDescription'),
      parser.getDicom('SeriesDescription'),
      parser.getFilePathComp(parser.FILEBASENAME) + '.dcm',
    ];
  },
});