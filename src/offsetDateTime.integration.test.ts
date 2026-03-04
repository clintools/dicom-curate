import curateDict from './curateDict'
import * as dcmjs from 'dcmjs'
import type { TMappingOptions } from './types'

describe('Integration tests: Date offsets should only affect instance data, not scanner data', () => {
  // Test DICOM data with both instance and scanner dates
  const originalCalibrationDate = '20220301'
  const originalManufactureDate = '20200815'
  const originalCalibrationDateTime = '20220301101530.000000'

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
      // Instance data dates (should be offset)
      '00080020': { vr: 'DA', Value: ['20230415'] }, // StudyDate
      '00080021': { vr: 'DA', Value: ['20230415'] }, // SeriesDate
      '00080022': { vr: 'DA', Value: ['20230415'] }, // AcquisitionDate
      '00080023': { vr: 'DA', Value: ['20230415'] }, // ContentDate
      '00080030': { vr: 'TM', Value: ['143022.123456'] }, // StudyTime
      '00080031': { vr: 'TM', Value: ['143522.654321'] }, // SeriesTime
      '00080032': { vr: 'TM', Value: ['144022.987654'] }, // AcquisitionTime
      '00080033': { vr: 'TM', Value: ['144522.123456'] }, // ContentTime

      // Scanner/Device data dates (should NOT be offset when retainDeviceIdentityOption is true)
      '00181200': { vr: 'DA', Value: [originalCalibrationDate] }, // DateOfLastCalibration
      '00181204': { vr: 'DA', Value: [originalManufactureDate] }, // DateOfManufacture
      '00181202': { vr: 'DT', Value: [originalCalibrationDateTime] }, // DateTimeOfLastCalibration

      // Other required fields for valid DICOM
      '00100010': { vr: 'PN', Value: ['Test^Patient'] }, // PatientName
      '00100020': { vr: 'LO', Value: ['TEST123'] }, // PatientID
      '0020000d': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.3'] }, // StudyInstanceUID
      '0020000e': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.4'] }, // SeriesInstanceUID
      '00080018': { vr: 'UI', Value: ['1.2.3.4.5.6.7.8.9.5'] }, // SOPInstanceUID
      '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] }, // SOPClassUID
      '00080060': { vr: 'CS', Value: ['CT'] }, // Modality
    },
  })

  const createMappingOptions = (
    dateOffset: string,
    retainDeviceIdentity = true,
  ): TMappingOptions => ({
    curationSpec: () => ({
      inputPathPattern: 'protocol/center/subject/timepoint/scan',
      version: '3.0' as const,
      hostProps: {},
      dicomPS315EOptions: {
        cleanDescriptorsOption: false,
        cleanDescriptorsExceptions: [],
        retainLongitudinalTemporalInformationOptions: 'Offset' as const,
        retainPatientCharacteristicsOption: [],
        retainDeviceIdentityOption: retainDeviceIdentity,
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
    dateOffset,
    columnMappings: { rows: [], rowIndexByFieldValue: {} },
  })

  it('offsets instance dates but preserves scanner dates when retainDeviceIdentityOption is true', () => {
    const testDicomData = createTestDicomData()
    const mappingOptions = createMappingOptions('P30D') // 30 days offset

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testDicomData,
      mappingOptions,
    )

    // Convert to naturalized format for easier checking
    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Instance dates should be offset by 30 days
    expect(naturalized.StudyDate).toEqual('20230515') // 20230415 + 30 days
    expect(naturalized.SeriesDate).toEqual('20230515') // 20230415 + 30 days
    expect(naturalized.AcquisitionDate).toEqual('20230515') // 20230415 + 30 days
    expect(naturalized.ContentDate).toEqual('20230515') // 20230415 + 30 days

    // Times should remain the same (only date portion changes for DA fields)
    expect(naturalized.StudyTime).toEqual('143022.123456')
    expect(naturalized.SeriesTime).toEqual('143522.654321')
    expect(naturalized.AcquisitionTime).toEqual('144022.987654')
    expect(naturalized.ContentTime).toEqual('144522.123456')

    // Scanner dates should be preserved (not offset)
    expect(naturalized.DateOfLastCalibration).toEqual(originalCalibrationDate)
    expect(naturalized.DateOfManufacture).toEqual(originalManufactureDate)
    expect(naturalized.DateTimeOfLastCalibration).toEqual(
      originalCalibrationDateTime,
    )
  })

  it('offsets both instance and scanner dates when retainDeviceIdentityOption is false', () => {
    const testDicomData = createTestDicomData()
    const mappingOptions = createMappingOptions('P30D', false)

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testDicomData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Instance dates should be offset
    expect(naturalized.StudyDate).toEqual('20230515')
    expect(naturalized.SeriesDate).toEqual('20230515')
    expect(naturalized.AcquisitionDate).toEqual('20230515')
    expect(naturalized.ContentDate).toEqual('20230515')

    // Scanner dates should ALSO be offset when retainDeviceIdentityOption is false
    expect(naturalized.DateOfLastCalibration).toEqual('20220331') // 20220301 + 30 days
    expect(naturalized.DateOfManufacture).toEqual('20200914') // 20200815 + 30 days
    expect(naturalized.DateTimeOfLastCalibration).toEqual(
      '20220331101530.000000',
    ) // 20220301 + 30 days
  })

  it('handles negative date offsets correctly for both instance and scanner dates', () => {
    const testDicomData = createTestDicomData()
    const mappingOptions = createMappingOptions('-P45D') // 45 days backward

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testDicomData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Instance dates should be offset backward by 45 days
    expect(naturalized.StudyDate).toEqual('20230301') // 20230415 - 45 days
    expect(naturalized.SeriesDate).toEqual('20230301')
    expect(naturalized.AcquisitionDate).toEqual('20230301')
    expect(naturalized.ContentDate).toEqual('20230301')

    // Scanner dates should be preserved
    expect(naturalized.DateOfLastCalibration).toEqual(originalCalibrationDate)
    expect(naturalized.DateOfManufacture).toEqual(originalManufactureDate)
    expect(naturalized.DateTimeOfLastCalibration).toEqual(
      originalCalibrationDateTime,
    )
  })

  it('handles time precision correctly in DT fields during offset', () => {
    const testData = createTestDicomData()
    // Add a more complex DT field with fractional seconds
    testData.dict['0008002a'] = {
      vr: 'DT',
      Value: ['20230415143022.123456+0200'],
    } // AcquisitionDateTime with timezone

    const mappingOptions = createMappingOptions('PT2H30M15.555555S') // Complex time offset

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Should handle fractional seconds and timezone preservation
    expect(naturalized.AcquisitionDateTime).toEqual(
      '20230415170037.679011+0200',
    )
  })

  it('preserves original formatting of date fields after offset', () => {
    const testData = {
      meta: createTestDicomData().meta,
      dict: {
        ...createTestDicomData().dict,
        // Test various date formats
        '00080020': { vr: 'DA', Value: ['20230415'] }, // Full date
        '00080030': { vr: 'TM', Value: ['14'] }, // Hours only
        '00080031': { vr: 'TM', Value: ['1430'] }, // Hours and minutes
        '00080032': { vr: 'TM', Value: ['143022'] }, // Hours, minutes, seconds
        '00080033': { vr: 'TM', Value: ['143022.123'] }, // With fractional seconds
      },
    }

    const mappingOptions = createMappingOptions('PT1H')

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Date should be offset but format preserved
    expect(naturalized.StudyDate).toEqual('20230415') // Date unchanged for time-only offset

    // Times should be offset and format preserved
    expect(naturalized.StudyTime).toEqual('15') // 14 + 1 hour, format preserved
    expect(naturalized.SeriesTime).toEqual('1530') // 1430 + 1 hour, format preserved
    expect(naturalized.AcquisitionTime).toEqual('153022') // 143022 + 1 hour, format preserved
    expect(naturalized.ContentTime).toEqual('153022.123') // 143022.123 + 1 hour, format preserved
  })

  it('handles date fields in sequences correctly', () => {
    const testData = createTestDicomData()
    // Add a sequence with date fields
    testData.dict['00082112'] = {
      // SourceImageSequence
      vr: 'SQ',
      Value: [
        {
          '00080020': { vr: 'DA', Value: ['20230415'] }, // StudyDate in sequence
          '00181200': { vr: 'DA', Value: ['20220301'] }, // DateOfLastCalibration in sequence
        },
      ],
    }

    const mappingOptions = createMappingOptions('P30D')

    const { dicomData: result } = curateDict(
      'test/file/path.dcm',
      testData,
      mappingOptions,
    )

    const naturalized = (
      dcmjs.data.DicomMetaDictionary as any
    ).naturalizeDataset(result.dict)

    // Check sequence handling
    expect(naturalized.SourceImageSequence[0].StudyDate).toEqual('20230515') // Instance date offset
    expect(naturalized.SourceImageSequence[0].DateOfLastCalibration).toEqual(
      originalCalibrationDate,
    ) // Scanner date preserved
  })
})
