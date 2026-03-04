import curateDict from './curateDict'
import * as dcmjs from 'dcmjs'
import type { TMappingOptions } from './types'

describe('Nested Sequence ID Retention Tests', () => {
  // Test DICOM data structure for nested sequence testing
  const createTestDicomData = () => ({
    meta: {
      '00020000': { vr: 'UL', Value: ['194'] },
      '00020001': { vr: 'OB', Value: [''] },
      '00020002': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] },
      '00020003': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.1'] },
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2'] },
      '00020012': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.2'] },
      '00020013': { vr: 'SH', Value: ['DICOM-CURATE'] },
    },
    dict: {
      // Basic required fields for valid DICOM
      '00100010': { vr: 'PN', Value: ['Test^Patient'] }, // PatientName
      '00100020': { vr: 'LO', Value: ['TEST123'] }, // PatientID
      '0020000d': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.3'] }, // StudyInstanceUID
      '0020000e': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.4'] }, // SeriesInstanceUID
      '00080018': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.5'] }, // SOPInstanceUID
      '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] }, // SOPClassUID
      '00080060': { vr: 'CS', Value: ['CT'] }, // Modality
    },
  })

  const createBasicMappingOptions = (): TMappingOptions => ({
    curationSpec: () => ({
      inputPathPattern: 'protocol/center/subject/timepoint/scan',
      version: '3.0' as const,
      hostProps: {},
      dicomPS315EOptions: {
        cleanDescriptorsOption: false,
        cleanDescriptorsExceptions: [],
        retainLongitudinalTemporalInformationOptions: 'Off' as const,
        retainPatientCharacteristicsOption: false,
        retainDeviceIdentityOption: true,
        retainUIDsOption: 'Off' as const,
        retainSafePrivateOption: 'Off' as const,
        retainInstitutionIdentityOption: false,
      },
      modifyDicomHeader: () => ({}),
      outputFilePathComponents: (parser) => [
        parser.protectUid(parser.getDicom('SeriesInstanceUID')),
        parser.getFilePathComp(parser.FILENAME),
      ],
      errors: () => [],
    }),
    skipWrite: true,
    skipModifications: false,
    skipValidation: true,
    columnMappings: { rows: [], rowIndexByFieldValue: {} },
  })

  it('handles nested Other Patient IDs Sequence with ID retention correctly', () => {
    const testData = createTestDicomData()

    // Add the Other Patient IDs
    testData.dict['00101002'] = {
      // OtherPatientIDsSequence
      vr: 'SQ',
      Value: [
        {
          // Item 1 - with nested Patient ID elements
          '00100020': { vr: 'LO', Value: ['PATIENT_ID_1'] }, // PatientID
          '00100021': { vr: 'LO', Value: ['ISSUER_1'] }, // IssuerOfPatientID
          '00101000': { vr: 'LO', Value: ['OTHER_PATIENT_ID_1'] }, // OtherPatientIDs
          '00101001': { vr: 'PN', Value: ['Other^Patient^Names'] }, // OtherPatientNames
          '00101005': { vr: 'PN', Value: ['Patient^Birth^Name'] }, // PatientBirthName
          '00101040': { vr: 'LO', Value: ['123 Main St'] }, // PatientAddress
          '00101060': { vr: 'PN', Value: ['Mother^Birth^Name'] }, // PatientMotherBirthName
          '00102154': { vr: 'SH', Value: ['555-1234'] }, // PatientTelephoneNumbers
          '000221F0': { vr: 'LO', Value: ['Buddhist'] }, // PatientReligiousPreference (from screenshot)
        },
      ],
    }

    const mappingOptions = createBasicMappingOptions()

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)
    // According to PS3.15E, the OtherPatientIDsSequence should be completely removed
    // since it has basicProfile: 'X' (remove) and no retention options are configured
    expect(naturalized.OtherPatientIDsSequence).toBeUndefined()
  })

  it('confirms that retainPatientCharacteristicsOption only applies at root level, not within sequences', () => {
    const testData = createTestDicomData()

    // Add the Other Patient IDs Sequence with fields that would be eligible for retention at root level
    testData.dict['00101002'] = {
      // OtherPatientIDsSequence
      vr: 'SQ',
      Value: [
        {
          '00100020': { vr: 'LO', Value: ['PATIENT_ID_1'] }, // PatientID
          '00100021': { vr: 'LO', Value: ['ISSUER_1'] }, // IssuerOfPatientID
          '00101010': { vr: 'AS', Value: ['025Y'] }, // PatientAge (would be retained at root)
          '00101030': { vr: 'DS', Value: ['70.5'] }, // PatientWeight (would be retained at root)
        },
      ],
    }

    // Add the same fields at root level to demonstrate they ARE retained there
    testData.dict['00101010'] = { vr: 'AS', Value: ['030Y'] } // PatientAge at root
    testData.dict['00101030'] = { vr: 'DS', Value: ['75.0'] } // PatientWeight at root

    // Create mapping options with specific patient characteristics retention
    const mappingOptions: TMappingOptions = {
      curationSpec: () => ({
        inputPathPattern: 'protocol/center/subject/timepoint/scan',
        version: '3.0' as const,
        hostProps: {},
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: ['PatientAge', 'PatientWeight'], // Retain these eligible fields
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off' as const,
          retainInstitutionIdentityOption: false,
        },
        modifyDicomHeader: () => ({}),
        outputFilePathComponents: (parser) => [
          parser.protectUid(parser.getDicom('SeriesInstanceUID')),
          parser.getFilePathComp(parser.FILENAME),
        ],
        errors: () => [],
      }),
      skipWrite: true,
      skipModifications: false,
      skipValidation: true,
      columnMappings: { rows: [], rowIndexByFieldValue: {} },
    }

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // The sequence should be removed entirely despite containing "retainable" fields
    // because retainPatientCharacteristicsOption only applies at root level
    expect(naturalized.OtherPatientIDsSequence).toBeUndefined()

    // But the same fields at root level should be retained
    expect(naturalized.PatientAge).toEqual('030Y')
    expect(naturalized.PatientWeight).toEqual('75.0')
  })

  it('correctly handles multiple items in Other Patient IDs Sequence', () => {
    const testData = createTestDicomData()

    // Add the Other Patient IDs Sequence with multiple items
    testData.dict['00101002'] = {
      // OtherPatientIDsSequence
      vr: 'SQ',
      Value: [
        {
          '00100020': { vr: 'LO', Value: ['PATIENT_ID_1'] }, // PatientID
          '00100021': { vr: 'LO', Value: ['ISSUER_1'] }, // IssuerOfPatientID
        },
        {
          '00100020': { vr: 'LO', Value: ['PATIENT_ID_2'] }, // PatientID
          '00100021': { vr: 'LO', Value: ['ISSUER_2'] }, // IssuerOfPatientID
          '00101000': { vr: 'LO', Value: ['OTHER_PATIENT_ID_2'] }, // OtherPatientIDs
        },
      ],
    }

    const mappingOptions = createBasicMappingOptions()

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // The entire sequence should be removed since no retention options are configured
    expect(naturalized.OtherPatientIDsSequence).toBeUndefined()
  })

  it('handles deeply nested sequences with patient information', () => {
    const testData = createTestDicomData()

    // Add a more complex nested structure
    testData.dict['00400275'] = {
      // RequestAttributesSequence
      vr: 'SQ',
      Value: [
        {
          '00101002': {
            // OtherPatientIDsSequence nested within another sequence
            vr: 'SQ',
            Value: [
              {
                '00100020': { vr: 'LO', Value: ['NESTED_PATIENT_ID'] }, // PatientID
                '00100021': { vr: 'LO', Value: ['NESTED_ISSUER'] }, // IssuerOfPatientID
              },
            ],
          },
        },
      ],
    }

    const mappingOptions = createBasicMappingOptions()

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Test that deeply nested patient information is also properly handled
    // Since RequestAttributesSequence has basicProfile: 'X' and contains no retained elements,
    // the entire sequence should be removed
    expect(naturalized.RequestAttributesSequence).toBeUndefined()
  })
})
