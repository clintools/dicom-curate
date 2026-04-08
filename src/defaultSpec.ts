import { specVersion } from './config/specVersion'
import { defaultPs315Options } from './deidentifyPS315E'
import type { TCurationSpecification } from './types'

export const defaultSpec: TCurationSpecification = {
  version: specVersion,
  hostProps: {},
  excludedFiletypes: [],
  dicomPS315EOptions: defaultPs315Options,
  inputPathPattern: '',
  modifyDicomHeader: () => ({}),
  outputFilePathComponents: (parser) => [
    parser.protectUid(parser.getDicom('SeriesInstanceUID')),
    parser.getFilePathComp(parser.FILENAME),
  ],
  errors: () => [],
}
