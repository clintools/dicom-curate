import type { SpecPart } from '../composeSpecs'
import type { TCurationSpecification, TParser } from '../types'

type THostProps = {
  protocolNumber: string
  activityProviderName: string
  timepointNames: string[]
}

type Ctx = Partial<{
  scanName: (parser: TParser) => string
  fallbackScanName: (parser: TParser) => string
  version: string
  hostProps: THostProps
  centerSubjectId: (parser: TParser) => string
  timepointName: (parser: TParser) => string
  protocolNumber: (parser: TParser) => string
  centerSubjectIdPattern: RegExp
}>

// Still a function so all eval stuff stays the same.
// Discover composed specs by checking return value is array
export function composedSpec(): SpecPart<THostProps, Ctx>[] {
  return [
    function fallbackScanName() {
      // Define a scan name to use if provider cannot provide one.
      function fallbackScanName(parser: TParser) {
        const modality = parser.getDicom('Modality') ?? ''
        const imageType = parser.getDicom('ImageType') ?? ''
        const imageTypeStr = Array.isArray(imageType)
          ? imageType.join('_')
          : imageType
        return `${modality}-${imageTypeStr}`
      }

      return {
        ctx: { fallbackScanName },
      }
    },

    function projectSettings(ctxIn) {
      const hostProps = {
        protocolNumber: 'Sample_Protocol_Number',
        activityProviderName: 'Sample_CRO',
        timepointNames: ['Visit 1', 'Visit 2', 'Visit 3', 'EXCLUDE'],
      }

      return {
        ctx: {
          // For information / from the MS Word transfer spec, but not currently enforced.
          scanNames_unavailable: [
            'PET-CT_Abd',
            'LD_CT_Abd',
            'PET-CT_WB',
            'LD_CT_Abd',
            'PET-CT_Abd_ToF+PSF',
            'PET-CT_WB_ToF+PSF',
          ],
          // In this study we are auto-creating scan names, not using provider scan names.
          scanName: ctxIn.fallbackScanName,
          // Make hostProps available to subsequent SpecParts
          hostProps,
        },
        spec: { version: '3.0', hostProps },
      }
    },

    // If the data provider supports scan names, can overwrite scanName(parser: TParser) here.
    function cro1Ingestion(ctxIn) {
      // Where to get reference data for various identifiers.
      function centerSubjectId(parser: TParser) {
        return parser.getDicom('ClinicalTrialSubjectReadingID') ?? 'UNKNOWN'
      }

      function timepointName(parser: TParser) {
        return parser.getDicom('ClinicalTrialTimePointID') ?? 'UNKNOWN'
      }

      function protocolNumber(parser: TParser) {
        return parser.getFilePathComp('protocolNumber')
      }

      return {
        ctx: { centerSubjectId, timepointName, protocolNumber },
        spec: {
          version: '3.0',
          // We might use a subset of the identifiers captured here.
          inputPathPattern:
            'protocolNumber/siteId/centerSubjectId/timepoint/procedure/scanStatus/zippedName',
        },
      }
    },

    function sharedDefs(ctxIn) {
      const centerSubjectIdPattern = /^[A-Z]{2}\d{2}-\d{3}$/

      return {
        ctx: { centerSubjectIdPattern },
        spec: {
          version: '3.0',
          // This specifies the standardized DICOM de-identification
          dicomPS315EOptions: {
            cleanDescriptorsOption: true,
            cleanDescriptorsExceptions: ['SeriesDescription'],
            retainLongitudinalTemporalInformationOptions: 'Full',
            retainPatientCharacteristicsOption: [
              'PatientWeight',
              'PatientSize',
              'PatientAge',
              'PatientSex',
              'SelectorASValue',
            ],
            retainDeviceIdentityOption: true,
            retainUIDsOption: 'Hashed',
            retainSafePrivateOption: 'Quarantine',
            retainInstitutionIdentityOption: true,
          },

          modifyDicomHeaders(parser: TParser) {
            return {
              PatientID: ctxIn.centerSubjectId!(parser),
              PatientName: ctxIn.centerSubjectId!(parser),
              StudyDescription: ctxIn.timepointName!(parser),
              ClinicalTrialTimePointID: ctxIn.timepointName!(parser),
              ClinicalTrialCoordinatingCenterName:
                ctxIn.hostProps!.activityProviderName,
              // NOTE: see how we execute scan(parser)
              ClinicalTrialSeriesDescription: ctxIn.scanName!(parser),
            }
          },

          outputFilePathComponents(parser) {
            return [
              ctxIn.hostProps!.protocolNumber,
              ctxIn.hostProps!.activityProviderName,
              ctxIn.centerSubjectId!(parser),
              ctxIn.timepointName!(parser),
              ctxIn.scanName!(parser) +
                '=' +
                (parser.getDicom('SeriesNumber') ?? 'UNKNOWN'),
              parser.getFilePathComp(parser.FILEBASENAME) + '.dcm',
            ]
          },

          errors(parser) {
            const modality = parser.getDicom('Modality') ?? ''
            const filename = parser.getFilePathComp(parser.FILEBASENAME)
            const seriesUid = parser.getDicom('SeriesInstanceUID') ?? ''
            const centerSubjectId = ctxIn.centerSubjectId!(parser)
            const timepointNames = ctxIn.hostProps!.timepointNames

            return [
              [
                `Invalid protocol number provided, should be '${ctxIn.hostProps!.protocolNumber}'`,
                ctxIn.protocolNumber !== ctxIn.protocolNumber,
              ],
              [
                'Invalid DICOM site-subject format',
                !centerSubjectId.match(centerSubjectIdPattern),
              ],
              [
                'Invalid ClinicalTrialTimePointID descriptor',
                !timepointNames.includes(
                  parser.getDicom('ClinicalTrialTimePointID'),
                ),
              ],
              // DICOM header
              ['Missing Modality', parser.missingDicom('Modality')],
              ['Missing SOP Class UID', parser.missingDicom('SOPClassUID')],
              [
                'Missing Series Instance UID',
                parser.missingDicom('SeriesInstanceUID'),
              ],
              [
                'Missing Study Instance UID',
                parser.missingDicom('StudyInstanceUID'),
              ],
              [
                'Missing SOP Instance UID',
                parser.missingDicom('SOPInstanceUID'),
              ],
              ['Missing Study Date', parser.missingDicom('StudyDate')],
              ['Missing Series Date', parser.missingDicom('SeriesDate')],
              [
                'Missing Acquisition Date',
                parser.missingDicom('AcquisitionDate'),
              ],
              ['Missing Study Time', parser.missingDicom('StudyTime')],
              ['Missing Series Time', parser.missingDicom('SeriesTime')],
              ['Missing Patient Weight', parser.missingDicom('PatientWeight')],
              ['Missing Patient Size', parser.missingDicom('PatientSize')],
              ['Missing Patient Age', parser.missingDicom('PatientAge')],
              ['Missing Patient Sex', parser.missingDicom('PatientSex')],
              [
                'Missing Acquisition Time',
                parser.missingDicom('AcquisitionTime'),
              ],
              [
                'Missing Image Position (Patient)',
                parser.missingDicom('ImagePositionPatient'),
              ],
              [
                'Missing Number of Energy Windows on NM',
                parser.missingDicom('NumberOfEnergyWindows') &&
                  modality === 'NM',
              ],
              [
                'Missing Energy Window Information Sequence on NM',
                parser.missingDicom('EnergyWindowInformationSequence') &&
                  modality === 'NM',
              ],
              [
                'Missing Energy Window Range Sequence on NM',
                parser.missingDicom(
                  'EnergyWindowInformationSequence[0].EnergyWindowRangeSequence',
                ) && modality === 'NM',
              ],
              [
                'Missing Radiopharmaceutical Information Sequence on NM',
                parser.missingDicom('RadiopharmaceuticalInformationSequence') &&
                  modality === 'NM',
              ],
              [
                'Missing Series Type on PET',
                parser.missingDicom('SeriesType') && modality === 'PT',
              ],
              [
                'Missing Pixel Spacing on NM or PT or CT',
                parser.missingDicom('PixelSpacing') &&
                  ['NM', 'PT', 'CT'].includes(modality),
              ],
            ]
          },
        },
      }
    },
  ]
}
