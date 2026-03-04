import { composeSpecs } from './composeSpecs'
import { sampleBatchCurationSpecification } from './config/sampleBatchCurationSpecification'
import { sample2PassCurationSpecification } from './config/sample2PassCurationSpecification'
import { sample } from '../testdata/sample'
import curateDict from './curateDict'
import type { TMappingOptions, TCurationSpecification, TParser } from './types'

// Helper function to create equivalent composite spec from batch spec
function createEquivalentCompositeSpecFromBatch(): () => TCurationSpecification {
  const originalSpec = sampleBatchCurationSpecification()

  // Convert to composite spec format
  return () =>
    composeSpecs([
      {
        version: originalSpec.version,
        hostProps: originalSpec.hostProps,
        inputPathPattern: originalSpec.inputPathPattern,
        dicomPS315EOptions: originalSpec.dicomPS315EOptions,
        additionalData: originalSpec.additionalData,
        modifyDicomHeader: originalSpec.modifyDicomHeader,
        outputFilePathComponents: originalSpec.outputFilePathComponents,
        errors: originalSpec.errors,
      },
    ])
}

// Helper function to create equivalent composite spec from 2-pass spec
function createEquivalentCompositeSpecFrom2Pass(): () => TCurationSpecification {
  const originalSpec = sample2PassCurationSpecification()

  // Convert to composite spec format
  return () =>
    composeSpecs([
      {
        version: originalSpec.version,
        hostProps: originalSpec.hostProps,
        inputPathPattern: originalSpec.inputPathPattern,
        dicomPS315EOptions: originalSpec.dicomPS315EOptions,
        additionalData: originalSpec.additionalData,
        modifyDicomHeader: originalSpec.modifyDicomHeader,
        outputFilePathComponents: originalSpec.outputFilePathComponents,
        errors: originalSpec.errors,
      },
    ])
}

// Helper function to test curation output equivalence
function testCurationEquivalence(
  oldStyleSpec: () => TCurationSpecification,
  compositeSpec: () => TCurationSpecification,
  filename: string,
) {
  const defaultTestOptions: TMappingOptions = {
    columnMappings: { rows: [], rowIndexByFieldValue: {} },
    curationSpec: oldStyleSpec,
  }

  const compositeTestOptions: TMappingOptions = {
    columnMappings: { rows: [], rowIndexByFieldValue: {} },
    curationSpec: compositeSpec,
  }

  const oldResult = curateDict(filename, sample, defaultTestOptions)
  const newResult = curateDict(filename, sample, compositeTestOptions)

  // Verify both have no errors
  expect(oldResult.mapResults.errors).toHaveLength(0)
  expect(newResult.mapResults.errors).toHaveLength(0)

  // Compare the key outputs
  expect(newResult.mapResults.outputFilePath).toBe(
    oldResult.mapResults.outputFilePath,
  )
  expect(newResult.mapResults.sourceInstanceUID).toBe(
    oldResult.mapResults.sourceInstanceUID,
  )
  expect(newResult.mapResults.mappings).toEqual(oldResult.mapResults.mappings)
  expect(newResult.mapResults.quarantine).toEqual(
    oldResult.mapResults.quarantine,
  )
  expect(newResult.mapResults.anomalies).toEqual(oldResult.mapResults.anomalies)

  // Compare DICOM data structure (verify keys are the same)
  expect(Object.keys(newResult.dicomData.dict)).toEqual(
    Object.keys(oldResult.dicomData.dict),
  )
  expect(Object.keys(newResult.dicomData.meta)).toEqual(
    Object.keys(oldResult.dicomData.meta),
  )
}

describe('composeSpecs equivalence tests', () => {
  const passingFilename =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen/0/test.dcm'

  it('produces equivalent output for sampleBatchCurationSpecification', () => {
    testCurationEquivalence(
      sampleBatchCurationSpecification,
      createEquivalentCompositeSpecFromBatch(),
      passingFilename,
    )
  })

  it('produces equivalent output for sample2PassCurationSpecification', () => {
    const csv2PassTestOptions: TMappingOptions = {
      columnMappings: {
        rows: [
          {
            PatNamePatId: 'Doe^John=Test Long String',
            CenterSubjectId: 'XX01-001',
            PatNameIDSeriesDesc: 'Doe^John=Test Long String=Test Long String',
            Timepoint: 'Visit 1',
            ScanName: 'PET-CT',
            Comment: '',
          },
        ],
        rowIndexByFieldValue: {
          centerSubjectId: { 'Doe^John=Test Long String': 0 },
          timepoint: { 'Doe^John=Test Long String=Test Long String': 0 },
          scanName: { 'Doe^John=Test Long String=Test Long String': 0 },
        },
      },
      curationSpec: sample2PassCurationSpecification,
    }

    const csv2PassCompositeOptions: TMappingOptions = {
      columnMappings: csv2PassTestOptions.columnMappings,
      curationSpec: createEquivalentCompositeSpecFrom2Pass(),
    }

    const oldResult = curateDict(passingFilename, sample, csv2PassTestOptions)
    const newResult = curateDict(
      passingFilename,
      sample,
      csv2PassCompositeOptions,
    )

    // Compare the key outputs
    // Note: The composite spec may produce different error patterns because the composite specs
    // accumulate errors from spec components
    expect(newResult.mapResults.outputFilePath).toBe(
      oldResult.mapResults.outputFilePath,
    )
    expect(newResult.mapResults.sourceInstanceUID).toBe(
      oldResult.mapResults.sourceInstanceUID,
    )
    expect(newResult.mapResults.mappings).toEqual(oldResult.mapResults.mappings)
    expect(newResult.mapResults.quarantine).toEqual(
      oldResult.mapResults.quarantine,
    )
    expect(newResult.mapResults.anomalies).toEqual(
      oldResult.mapResults.anomalies,
    )
  })

  it('composeSpecs accepts single spec without array wrapping', () => {
    const originalSpec = sampleBatchCurationSpecification()

    const composedSpec = composeSpecs({
      version: originalSpec.version,
      hostProps: originalSpec.hostProps,
      inputPathPattern: originalSpec.inputPathPattern,
      dicomPS315EOptions: originalSpec.dicomPS315EOptions,
      additionalData: originalSpec.additionalData,
      modifyDicomHeader: originalSpec.modifyDicomHeader,
      outputFilePathComponents: originalSpec.outputFilePathComponents,
      errors: originalSpec.errors,
    })

    // Verify the composed spec has the same properties
    expect(composedSpec.version).toBe(originalSpec.version)
    expect(composedSpec.hostProps).toEqual(originalSpec.hostProps)
    expect(composedSpec.inputPathPattern).toBe(originalSpec.inputPathPattern)
    expect(composedSpec.dicomPS315EOptions).toEqual(
      originalSpec.dicomPS315EOptions,
    )
    expect(composedSpec.additionalData).toEqual(originalSpec.additionalData)
  })

  it('composeSpecs merges multiple specs correctly', () => {
    const baseSpec = {
      version: '3.0',
      hostProps: { protocolNumber: 'Base_Protocol' },
      inputPathPattern: 'base/pattern',
      dicomPS315EOptions: {
        cleanDescriptorsOption: true,
        cleanDescriptorsExceptions: ['SeriesDescription'],
        retainLongitudinalTemporalInformationOptions: 'Full' as const,
        retainPatientCharacteristicsOption: ['PatientAge'] as string[],
        retainDeviceIdentityOption: true,
        retainUIDsOption: 'Hashed' as const,
        retainSafePrivateOption: 'Quarantine' as const,
        retainInstitutionIdentityOption: true,
      },
      modifyDicomHeader: (parser: TParser) => ({
        PatientID: 'base',
        ClinicalTrialCoordinatingCenterName: 'Sample_CRO',
        ClinicalTrialSeriesDescription: parser.getFilePathComp('series'),
        PatientName: parser.getFilePathComp('patient'),
      }),
      outputFilePathComponents: () => ['base', 'output'],
      errors: () => [['base error', false] as [string, boolean]],
    }

    const extendSpec = {
      version: '3.0',
      hostProps: { activityProviderName: 'Extended_Provider' },
      dicomPS315EOptions: {
        cleanDescriptorsExceptions: ['StudyDescription'], // Should merge with base
        retainPatientCharacteristicsOption: ['PatientSex'] as string[], // Should merge with base
      },
      modifyDicomHeader: () => ({
        StudyDescription: 'extended',
      }),
      errors: () => [['extended error', false] as [string, boolean]],
    }

    const composedSpec = composeSpecs([baseSpec, extendSpec])

    // Verify merged hostProps (includes defaults from defaultSpec)
    expect(composedSpec.hostProps).toMatchObject({
      protocolNumber: 'Base_Protocol',
      activityProviderName: 'Extended_Provider',
    })

    // Verify merged PS3.15 options (includes defaults from defaultSpec)
    expect(composedSpec.dicomPS315EOptions).toMatchObject({
      cleanDescriptorsOption: true,
      cleanDescriptorsExceptions: ['SeriesDescription', 'StudyDescription'], // Merged arrays
      retainDeviceIdentityOption: true,
      retainUIDsOption: 'Hashed',
      retainSafePrivateOption: 'Quarantine',
      retainInstitutionIdentityOption: true,
    })
    // Verify that retainPatientCharacteristicsOption includes both base and extended values
    expect(composedSpec.dicomPS315EOptions).toMatchObject({
      retainPatientCharacteristicsOption: expect.arrayContaining([
        'PatientAge',
        'PatientSex',
      ]),
    })

    // Test that functions are merged (later takes precedence for most fields; errors accumulate)
    const mockParser = {
      getFilePathComp: () => 'mock-value',
      getDicom: () => 'mock-dicom-value',
      getMapping: () => 'mock-mapping-value',
      missingDicom: () => false,
    } as Partial<TParser> as TParser
    expect(composedSpec.modifyDicomHeader(mockParser)).toEqual({
      PatientID: 'base',
      StudyDescription: 'extended', // Extended overrides
      ClinicalTrialCoordinatingCenterName: 'Sample_CRO', // From base composite spec
      ClinicalTrialSeriesDescription: 'mock-value',
      PatientName: 'mock-value',
    })

    // Test that errors accumulate (includes errors from base composite spec plus our new ones)
    const allErrors = composedSpec.errors(mockParser)
    expect(allErrors).toEqual(
      expect.arrayContaining([
        ['base error', false],
        ['extended error', false],
      ]),
    )

    // Should contain our custom errors
    expect(allErrors.some((err) => err[0] === 'base error')).toBe(true)
    expect(allErrors.some((err) => err[0] === 'extended error')).toBe(true)

    // Test that latter spec has precedence for outputFilePathComponents
    expect(composedSpec.outputFilePathComponents(mockParser)).toEqual([
      'base',
      'output',
    ])
  })

  it('composeSpecs validates version consistency', () => {
    const spec1 = { version: '3.0' }
    const spec2 = { version: '2.0' }

    expect(() => composeSpecs([spec1, spec2])).toThrow(
      "All curation specification versions must be '3.0'",
    )
  })

  it('composeSpecs handles PS3.15 options merging correctly', () => {
    const spec1 = {
      version: '3.0',
      dicomPS315EOptions: {
        cleanDescriptorsOption: true,
        cleanDescriptorsExceptions: ['SeriesDescription'],
        retainPatientCharacteristicsOption: ['PatientAge'] as string[],
        retainLongitudinalTemporalInformationOptions: 'Full' as const,
        retainDeviceIdentityOption: true,
        retainUIDsOption: 'Hashed' as const,
        retainSafePrivateOption: 'Quarantine' as const,
        retainInstitutionIdentityOption: true,
      },
    }

    const spec2 = {
      version: '3.0',
      dicomPS315EOptions: {
        cleanDescriptorsExceptions: ['StudyDescription'],
        retainPatientCharacteristicsOption: false as const,
      },
    }

    const composedSpec = composeSpecs([spec1, spec2])

    expect(composedSpec.dicomPS315EOptions).toMatchObject({
      cleanDescriptorsExceptions: ['SeriesDescription', 'StudyDescription'],
      retainPatientCharacteristicsOption: false, // Second spec takes precedence for false
    })
  })

  it('composeSpecs handles "Off" PS3.15 options correctly', () => {
    const spec1 = {
      version: '3.0',
      dicomPS315EOptions: {
        cleanDescriptorsOption: true,
        cleanDescriptorsExceptions: ['SeriesDescription'],
      },
    }

    const spec2 = {
      version: '3.0',
      dicomPS315EOptions: 'Off' as const,
    }

    const composedSpec = composeSpecs([spec1, spec2])

    expect(composedSpec.dicomPS315EOptions).toBe('Off')
  })

  it('composeSpecs does not mutate global defaultSpec across multiple calls', () => {
    // Regression test: ensures defaultSpec is not mutated when called repeatedly
    const spec = {
      version: '3.0',
      modifyDicomHeader: () => ({ PatientName: 'Test' }),
      errors: () => [['Test error', false] as [string, boolean]],
    }

    const result1 = composeSpecs(spec)
    const result2 = composeSpecs(spec)
    const result3 = composeSpecs(spec)

    const mockParser = {} as Partial<TParser> as TParser

    // Each call should produce identical output
    expect(result1.modifyDicomHeader(mockParser)).toEqual({
      PatientName: 'Test',
    })
    expect(result2.modifyDicomHeader(mockParser)).toEqual({
      PatientName: 'Test',
    })
    expect(result3.modifyDicomHeader(mockParser)).toEqual({
      PatientName: 'Test',
    })

    // Errors should not accumulate across calls
    expect(result1.errors(mockParser)).toHaveLength(1)
    expect(result2.errors(mockParser)).toHaveLength(1)
    expect(result3.errors(mockParser)).toHaveLength(1)
  })
})
