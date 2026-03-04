import curateDict from './curateDict'
import { sample } from '../testdata/sample'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { TMappingOptions, TCurationSpecification } from './types'
import { elementNamesToAlwaysKeep } from './config/dicom/elementNamesToAlwaysKeep'
import { allElements } from '../testdata/allElements'
import { sampleBatchCurationSpecification } from './config/sampleBatchCurationSpecification'

// Like default curation spec with dicom header modifications ignored, plus custom options
function specWithOptions(
  options: Partial<TCurationSpecification>,
): () => TCurationSpecification {
  const batchSpec = sampleBatchCurationSpecification()

  return () => ({
    ...batchSpec,
    ...options,
    // but avoid DICOM header changes
    modifyDicomHeader() {
      return {}
    },
  })
}

const passingFilename =
  'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen/0/test.dcm'

describe('curateDict basic functionality', () => {
  // Base test options
  const defaultTestOptions: TMappingOptions = {
    columnMappings: { rows: [], rowIndexByFieldValue: {} },
    curationSpec: specWithOptions({
      dicomPS315EOptions: {
        cleanDescriptorsOption: true,
        cleanDescriptorsExceptions: [],
        retainLongitudinalTemporalInformationOptions: 'Off',
        retainPatientCharacteristicsOption: [],
        retainDeviceIdentityOption: true,
        retainUIDsOption: 'Hashed',
        retainSafePrivateOption: 'Quarantine',
        retainInstitutionIdentityOption: true,
      },
    }),
  } as const

  // To be used if we want to save test output
  const saveTestOutput = (filename: string, data: any) => {
    const testOutputDir = join(__dirname, '..', 'testdata', 'testoutput')
    if (!existsSync(testOutputDir)) {
      try {
        mkdirSync(testOutputDir, { recursive: true })
      } catch (err) {
        console.error('Could not create test output directory:', err)
      }
    }

    const outputPath = join(testOutputDir, filename)
    writeFileSync(outputPath, JSON.stringify(data, null, 2))
    console.log(`Test output saved to: ${outputPath}`)
    return outputPath
  }

  // Verify no errors in result
  const verifyNoErrors = (result: any) => {
    expect(result.mapResults.errors).toHaveLength(0)
  }

  const verifyDicomTagIsPreserved = (
    result: { dicomData: { dict: Record<string, any> } },
    tagId: string,
    expectedValue?: string,
  ) => {
    // Find passed tag in dicomData.dict
    const tag = result.dicomData.dict[tagId]
    expect(tag).toBeDefined()

    // Verify the tag has a Value property
    expect(tag.Value).toBeDefined()

    if (expectedValue) {
      // String value verification
      expect(tag.Value[0]).toBe(expectedValue)
      // TODO: Currently we don't verify the value of sequence items,
      // in the future we should pass expectedValues for sequences as well
      // instead of just check that they exist and have a length greater than 0
    } else if (tag.vr === 'SQ') {
      // Sequence verification
      expect(Array.isArray(tag.Value)).toBe(true)
      expect(tag.Value.length).toBeGreaterThan(0)
    }
  }

  // Function to get keyword from tag ID
  const getKeywordForTagId = (tagId: string): string | undefined => {
    // Normalize tagId to lowercase for case-insensitive comparison
    const normalizedTagId = tagId.toLowerCase()
    const element = allElements.find(
      (el: { id: string; keyword: string }) =>
        el.id.toLowerCase() === normalizedTagId,
    )

    return element?.keyword
  }

  // Function to get descriptor mappings from result mappings
  const getDescriptorMappings = (mappings: Record<string, any>) => {
    return Object.entries(mappings).filter(([path]) => {
      const tagName = path.split('.').pop()?.split('[')[0] // Get the tag name from the path
      return (
        tagName &&
        (tagName.endsWith('Comment') ||
          tagName.endsWith('Comments') ||
          tagName.endsWith('Description'))
      )
    })
  }

  /**
   * Checks if a specific UID exists in DICOM elements where it should have been anonymized.
   *
   * This function searches through the DICOM dataset to find instances where a specific UID
   * appears in elements that should have been anonymized according to the PS3.15 standard.
   * It distinguishes between elements that are allowed to keep their UIDs (based on configuration
   * and the DICOM standard) and those that should have had their UIDs removed or replaced.
   *
   * @param dicomData - The DICOM dataset to search through (containing meta and dict sections)
   * @param uid - The specific UID string to search for
   * @returns true if the UID is found in elements that should have been anonymized (indicating a problem),
   *          false if the UID is either not found or only found in elements that are allowed to keep their UIDs
   */
  const findProblematicUIDs = (dicomData: any, uid: string): boolean => {
    // TODO: Replace this with a smarter solution that leverages the `ps315EElements.ts` file
    // to dynamically determine which tags should be kept. Currently, this list is manually
    // maintained based on the UIDs that should be retained after processing `elementNamesToAlwaysKeep.ts`
    // and flagged with `rtnUIDsOpt: "K"` in `ps315EElements.ts`.
    const uidTagsToKeepPs315E = [
      '00281214', // LargePaletteColorLookupTableUID
      '00404023', // ReferencedGeneralPurposeScheduledProcedureStepTransactionUID
      '0040A172', // ReferencedObservationUIDTrial
      '0040A402', // ObservationSubjectUIDTrial
      '0040DB0C', // TemplateExtensionOrganizationUID
      '0040DB0D', // TemplateExtensionCreatorUID
      '300600C2', // RelatedFrameOfReferenceUID
    ].map((id) => id.toLowerCase())

    // Function to check if a tag should be kept based on its keyword or if it's in the special UID tags list
    const shouldKeepTag = (keyword: string, tagId: string): boolean => {
      // Check if tag ID is in our list of special UID tags to keep
      if (uidTagsToKeepPs315E.includes(tagId.toLowerCase())) {
        return true
      }
      // Otherwise check if the keyword is in elementNamesToAlwaysKeep
      return elementNamesToAlwaysKeep.includes(keyword)
    }

    // Track UIDs that should be removed but are still present
    const problematicUIDs: {
      tagId: string
      keyword: string | undefined
      section: string
    }[] = []

    // Check a dicomData section for problematic UIDs
    const checkDicomDataForProblematicUIDs = (
      section: 'meta' | 'dict',
      data: Record<string, any>,
    ) => {
      Object.entries(data || {}).forEach(([tagId, field]) => {
        if ((field as any).vr === 'UI' && (field as any).Value?.includes(uid)) {
          const keyword = getKeywordForTagId(tagId)
          // Only track if it should be deleted (not kept according to our rules)
          if (!keyword || !shouldKeepTag(keyword, tagId)) {
            problematicUIDs.push({ tagId, keyword, section })
          }
        }
      })
    }

    checkDicomDataForProblematicUIDs('meta', dicomData.meta)
    checkDicomDataForProblematicUIDs('dict', dicomData.dict)

    // Log problematic UIDs
    if (problematicUIDs.length > 0) {
      console.log(
        `Found ${uid} in ${problematicUIDs.length} tags that should be deleted but are kept:`,
      )
      problematicUIDs.forEach(({ tagId, keyword, section }) => {
        console.log(
          ` - [${section}] Tag ID: ${tagId}, Keyword: ${keyword || 'unknown'}`,
        )
      })
    }

    return problematicUIDs.length > 0
  }

  // Sample private tags arbitrarily added to test data
  const simplePrivateTag = '00051100'
  const nestedPrivateTag = 'GeneralMatchingSequence[0].00510014'

  it('removes private tags when retainSafePrivateOption is Off', () => {
    const withPrivateTagsRemoved = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: true,
          cleanDescriptorsExceptions: ['SeriesDescription'],
          retainLongitudinalTemporalInformationOptions: 'Full' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'Hashed' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: true,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withPrivateTagsRemoved)
    verifyNoErrors(result)

    // Verify private tags are not quarantined
    const quarantine = result.mapResults.quarantine
    expect(quarantine).toBeDefined()
    expect(simplePrivateTag in quarantine).toBe(false)
    expect(nestedPrivateTag in quarantine).toBe(false)

    // Verify private tags are marked for deletion
    const mappings = result.mapResults.mappings
    expect(mappings[simplePrivateTag]).toBeDefined()
    expect(mappings[simplePrivateTag][1]).toBe('delete')
    expect(mappings[simplePrivateTag][2]).toBe('notRetainSafePrivate')
    expect(mappings[nestedPrivateTag]).toBeDefined()
    expect(mappings[nestedPrivateTag][1]).toBe('delete')
    expect(mappings[nestedPrivateTag][2]).toBe('notRetainSafePrivate')
  })

  it('retains UIDs when retainUIDsOption is On', () => {
    const withRetainedUIDs = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Full' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'On' as const,
          retainSafePrivateOption: 'Quarantine',
          retainInstitutionIdentityOption: true,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withRetainedUIDs)
    verifyNoErrors(result)

    // Only known UID found in sample data
    const sampleUID = '1.2.941.12368.1.2.4.09'

    // loop through all mappings and verify the test UID is not found
    const uidFoundInMappings = Object.values(result.mapResults.mappings).some(
      (mapping) => {
        const valueToMap = mapping[0]
        return valueToMap === sampleUID
      },
    )

    // If the UID is found in mappings, it means it was modified when it should have been retained
    expect(uidFoundInMappings).toBe(false)
  })

  it('hashes UIDs when retainUIDsOption is Hashed', () => {
    const optionsWithHashedUIDs = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Full' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'Hashed' as const,
          retainSafePrivateOption: 'Quarantine',
          retainInstitutionIdentityOption: true,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, optionsWithHashedUIDs)
    verifyNoErrors(result)

    // Only known UID found in sample data and its hashed value
    const sampleUID = '1.2.941.12368.1.2.4.09'
    const hashedUID =
      '2.25.255105095089138143244134129008090048147174238061102242129'

    // Verify sourceInstanceUID is correct
    expect(result.mapResults.sourceInstanceUID).toBe(sampleUID)

    // Verify the original UID doesn't exist in dicomData where it should have been anonymized
    expect(findProblematicUIDs(result.dicomData, sampleUID)).toBe(false)

    // Verify UIDs are hashed
    const hasHashedUIDMappings = Object.entries(
      result.mapResults.mappings,
    ).some(([, mapping]) => {
      return (
        mapping[0] === sampleUID &&
        mapping[1] === 'replace' &&
        mapping[2] === 'notRetainInstanceUID' &&
        mapping[3] === hashedUID
      )
    })
    expect(hasHashedUIDMappings).toBe(true)
  })

  it('replaces UIDs with arbitrary values when retainUIDsOption is Off', () => {
    const withArbitraryUIDs = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Full' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Quarantine',
          retainInstitutionIdentityOption: true,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withArbitraryUIDs)
    verifyNoErrors(result)

    // Only known UID found in sample data
    const sampleUID = '1.2.941.12368.1.2.4.09'

    // Verify sourceInstanceUID is correct
    expect(result.mapResults.sourceInstanceUID).toBe(sampleUID)

    // Verify the original UID doesn't exist in dicomData where it should have been anonymized
    expect(findProblematicUIDs(result.dicomData, sampleUID)).toBe(false)

    // Define condition for identifying replaced UIDs
    const isReplacedUID = (mapping: unknown[]): boolean =>
      mapping[1] === 'replace' &&
      mapping[2] === 'notRetainInstanceUID' &&
      typeof mapping[3] === 'string'

    // Find arbitrary value that will replace UIDs
    let UIDreplacementValue: string | undefined
    for (const [, mapping] of Object.entries(result.mapResults.mappings)) {
      if (isReplacedUID(mapping)) {
        UIDreplacementValue = mapping[3] as string
        break
      }
    }
    expect(UIDreplacementValue).not.toBe(sampleUID) // Different from original value
    console.log('New arbitrary UID:', UIDreplacementValue)

    // Verify all UIDs are replaced with the same arbitrary value
    const mappings = result.mapResults.mappings
    const allUIDsReplacedWithSameValue = Object.entries(mappings).every(
      ([, mapping]) => {
        if (isReplacedUID(mapping)) {
          return (mapping[3] as string) === UIDreplacementValue
        }
        return true
      },
    )
    expect(allUIDsReplacedWithSameValue).toBe(true)
  })

  it('removes all descriptors when cleanDescriptorsOption is true with no exceptions', () => {
    const optionsWithAllDescriptorsRemoved = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: true,
          cleanDescriptorsExceptions: false,
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(
      passingFilename,
      sample,
      optionsWithAllDescriptorsRemoved,
    )
    verifyNoErrors(result)
    // Check that no descriptors exist in the dicomData
    const descriptorKeywords = ['Comment', 'Comments', 'Description']
    const descriptorsFound: {
      section: string
      tagId: string
      keyword: string
      value: any
    }[] = []

    // Check that no descriptors exist in the dicomData
    const checkSectionForDescriptors = (
      section: 'meta' | 'dict',
      data: Record<string, any>,
    ) => {
      if (!data) return

      Object.keys(data).forEach((tagId) => {
        const keyword = getKeywordForTagId(tagId)
        if (
          keyword &&
          descriptorKeywords.some((desc) => keyword.includes(desc))
        ) {
          const value = data[tagId]?.Value?.[0]
          // Only consider it a descriptor if it has a non-empty, non-redacted value
          if (value && value !== '' && value !== 'REDACTED') {
            descriptorsFound.push({ section, tagId, keyword, value })
          }
        }
      })
    }

    checkSectionForDescriptors('meta', result.dicomData.meta)
    checkSectionForDescriptors('dict', result.dicomData.dict)

    // Verify no descriptors were found
    expect(descriptorsFound).toEqual([])

    // Verify that the mappings show descriptors were removed
    const descriptorMappings = getDescriptorMappings(result.mapResults.mappings)

    // Verify we found some descriptor tags to check (ensure test is valid)
    expect(descriptorMappings.length).toBeGreaterThan(0)

    // Verify all descriptor tags are marked for deletion or replacement with reason 'cleanDescriptors' or 'PS3.15E'
    descriptorMappings.forEach(([path, mapping]) => {
      expect(['delete', 'replace']).toContain(mapping[1])
      expect(['cleanDescriptors', 'PS3.15E', 'mappingFunction']).toContain(
        mapping[2],
      )
      // Expect mapping[3] to be one of the following:
      // - undefined (for null values on the json file),
      // - 'REDACTED' (from `dummyValues.ts`),
      // - '' (when the library replaces the value with an empty string).
      expect([undefined, 'REDACTED', '']).toContain(mapping[3])
    })
  })

  it('applies PS3.15 rules to descriptors when cleanDescriptorsOption is false', () => {
    const withoutCleanDescriptors = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withoutCleanDescriptors)
    verifyNoErrors(result)

    // Find all mappings related to descriptors (ending with Comment, Comments, or Description)
    const descriptorMappings = getDescriptorMappings(result.mapResults.mappings)

    // Check that PS3.15 rules are applied (tags will be marked with 'PS3.15E' reason)
    // and not the general 'cleanDescriptors' reason
    const ps315Descriptors = descriptorMappings.filter(
      ([, mapping]) => mapping[2] === 'PS3.15E',
    )

    // Verify we have some PS3.15 descriptor tags
    expect(ps315Descriptors.length).toBeGreaterThan(0)

    // Verify none of the descriptors have 'cleanDescriptors' as reason
    const cleanDescriptorsTags = descriptorMappings.filter(
      ([, mapping]) => mapping[2] === 'cleanDescriptors',
    )
    expect(cleanDescriptorsTags.length).toBe(0)
  })

  it('preserves excepted descriptors when cleanDescriptorsOption is true with exceptions', () => {
    // Exceptions to preserve - structured as an array for iteration
    const descriptorsToPreserve = [
      {
        id: '0008103E',
        keyword: 'SeriesDescription',
        value: 'Test Long String',
      },
      {
        id: '20100152',
        keyword: 'ConfigurationInformationDescription',
        value: 'Test Long Text',
      },
    ]

    const withDescriptorExceptions = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: true,
          cleanDescriptorsExceptions: descriptorsToPreserve.map(
            (desc) => desc.keyword,
          ),
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withDescriptorExceptions)
    verifyNoErrors(result)

    // Verify that excepted descriptors are preserved in the dicomData
    descriptorsToPreserve.forEach((descriptor) => {
      verifyDicomTagIsPreserved(result, descriptor.id, descriptor.value)
    })
  })

  it('retains valid patient characteristics and anonymizes invalid entries when using retainPatientCharacteristicsOption', () => {
    // Patient characteristics that should be retained (valid with rtnPatCharsOpt="K")
    const patientCharacteristics = [
      { id: '00101010', keyword: 'PatientAge', value: '018Y' },
      { id: '00100040', keyword: 'PatientSex', value: 'TEST_CODE' },
      { id: '00101030', keyword: 'PatientWeight', value: '123.45' },
    ]

    // Non-patient characteristics or invalid entries that should be anonymized
    const nonPatientCharacteristics = [
      {
        keyword: 'PatientID',
        expectedAction: 'replace',
      },
      {
        keyword: 'PatientComments',
        expectedAction: 'delete',
      },
      {
        keyword: 'ResponsiblePerson',
        expectedAction: 'delete',
      },
      { keyword: 'NonExistentTag' },
    ]

    const withPatientCharacteristics = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [
            ...patientCharacteristics.map((pc) => pc.keyword),
            ...nonPatientCharacteristics.map((npc) => npc.keyword),
          ],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(
      passingFilename,
      sample,
      withPatientCharacteristics,
    )
    verifyNoErrors(result)

    const mappings = result.mapResults.mappings

    // Verify that explicitly listed valid patient characteristics are retained
    patientCharacteristics.forEach((pc) => {
      verifyDicomTagIsPreserved(result, pc.id, pc.value)
    })

    // Verify that non-patient characteristics are anonymized regardless of being in the list
    nonPatientCharacteristics.forEach((npc) => {
      if (npc.expectedAction) {
        expect(mappings[npc.keyword]).toBeDefined()
        expect(mappings[npc.keyword][1]).toBe(npc.expectedAction)
      }
    })
  })

  // Used by retainInstitutionIdentityOption tests to define all institution-related elements with rtnInstIdOpt="K"
  const institutionElements = [
    {
      id: '00120060',
      keyword: 'ClinicalTrialCoordinatingCenterName',
      value: 'Test Long String',
      basicProfile: 'Z',
    },
    {
      id: '00120081',
      keyword: 'ClinicalTrialProtocolEthicsCommitteeName',
      value: 'Test Long String',
      basicProfile: 'D',
    },
    {
      id: '00120030',
      keyword: 'ClinicalTrialSiteID',
      value: 'Test Long String',
      basicProfile: 'Z',
    },
    {
      id: '00120031',
      keyword: 'ClinicalTrialSiteName',
      value: 'Test Long String',
      basicProfile: 'Z',
    },
    {
      id: '00080081',
      keyword: 'InstitutionAddress',
      value: 'Test Short Text',
      basicProfile: 'X',
    },
    {
      id: '00081040',
      keyword: 'InstitutionalDepartmentName',
      value: 'Test Long String',
      basicProfile: 'X',
    },
    {
      id: '00081041',
      keyword: 'InstitutionalDepartmentTypeCodeSequence',
      value: 'Test value',
      basicProfile: 'X',
    },
    {
      id: '00080082',
      keyword: 'InstitutionCodeSequence',
      value: 'Test value',
      basicProfile: 'D',
    },
    {
      id: '00080080',
      keyword: 'InstitutionName',
      value: 'Test Long String',
      basicProfile: 'D',
    },
    {
      id: '04000564',
      keyword: 'SourceOfPreviousValues',
      value: 'Test Long String',
      basicProfile: 'Z',
    },
  ]

  it('preserves institution identity elements when retainInstitutionIdentityOption is true', () => {
    const withRtnInstitutionIdentity = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: true,
        },
      }),
    }

    const result = curateDict(
      passingFilename,
      sample,
      withRtnInstitutionIdentity,
    )
    verifyNoErrors(result)

    // Verify all institution-related elements are preserved when option is true
    institutionElements.forEach((element) => {
      const dictEntry = sample.dict[element.id]
      if (dictEntry && dictEntry.Value && dictEntry.Value.length > 0) {
        const value = dictEntry.Value[0]
        if (typeof value === 'string') {
          verifyDicomTagIsPreserved(result, element.id, element.value)
          // TODO: In future iterations, add way to test sequence values in verifyDicomTagIsPreserved
        } else if (dictEntry.vr === 'SQ') {
          verifyDicomTagIsPreserved(result, element.id)
        }
      }
    })
  })

  it('anonymizes institution identity elements when retainInstitutionIdentityOption is false', () => {
    const withRtnInstitutionIdentity = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'Off' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(
      passingFilename,
      sample,
      withRtnInstitutionIdentity,
    )
    verifyNoErrors(result)

    const mappings = result.mapResults.mappings

    // Helper function to verify an element is anonymized according to its basicProfile
    institutionElements.forEach((element) => {
      expect(mappings[element.keyword]).toBeDefined()
      expect(['replace', 'delete']).toContain(mappings[element.keyword][1])
      expect(mappings[element.keyword][2]).toBe('PS3.15E')

      // Additional checks based on basicProfile
      if (element.basicProfile === 'Z') {
        // Z tags should be replaced with empty values
        expect(mappings[element.keyword][3]).toBe('')
      } else if (element.basicProfile === 'D') {
        // D tags should be replaced with dummy values (not empty)
        expect(mappings[element.keyword][3]).not.toBe('')
        expect(mappings[element.keyword][3]).not.toBe(undefined)
      } else if (element.basicProfile === 'X') {
        // X tags should be deleted (undefined)
        expect(mappings[element.keyword][3]).toBe(undefined)
      }
    })
  })

  // Define test constants for device identity elements
  const deviceElements = [
    // Elements with rtnDevIdOpt="K" - should be preserved when option is true
    {
      id: '00203401',
      keyword: 'ModifyingDeviceID',
      rtnDevIdOpt: 'K',
      value: 'TEST_CODE',
    },
    {
      id: '0014407E',
      keyword: 'CalibrationDate', // Test that CalibrationDate is perserved even if retainLongitudinalTemporalInformationOptions is 'Off'
      rtnDevIdOpt: 'K',
      value: '20250101',
    },
    {
      id: '04000563',
      keyword: 'ModifyingSystem',
      rtnDevIdOpt: 'K',
      value: 'Test Long String',
    },
    {
      id: '3010002D',
      keyword: 'DeviceLabel',
      rtnDevIdOpt: 'K',
      value: 'Test Long String',
    },
    {
      id: '0018700A',
      keyword: 'DetectorID',
      rtnDevIdOpt: 'C', // This should always be cleaned regardless of option
    },
    {
      id: '21000140',
      keyword: 'PrintQueueID',
      rtnDevIdOpt: 'C', // This should always be cleaned regardless of option
    },
  ]

  it('preserves all "rtnDevIdOpt": "K" device identity elements when retainDeviceIdentityOption overrides temporal settings', () => {
    const withRtnDeviceIdentity = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: true,
          retainUIDsOption: 'On' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withRtnDeviceIdentity)
    verifyNoErrors(result)

    const mappings = result.mapResults.mappings
    const dict = result.dicomData.dict

    // Verify all device-related elements are handled correctly based on their rtnDevIdOpt value
    deviceElements.forEach((element) => {
      // For elements with rtnDevIdOpt="K" when option is true
      if (element.rtnDevIdOpt === 'K') {
        // Element should not exist in mappings
        expect(mappings[element.keyword]).toBeUndefined()

        // Element should keep its original value in dict
        expect(dict[element.id]).toBeDefined()
        expect(dict[element.id].Value?.[0]).toBe(element.value)
      }
      // For elements with rtnDevIdOpt="C" when option is true - should ALWAYS be cleaned
      else if (element.rtnDevIdOpt === 'C') {
        if (mappings[element.keyword]) {
          // Should be deleted or replaced according to its basicProfile
          expect(['delete', 'replace']).toContain(mappings[element.keyword][1])

          // The reason should be PS3.15E (based on BasicProfile)
          expect(mappings[element.keyword][2]).toBe('PS3.15E')
        }
      }
    })
  })

  it('cleans all device identity elements when retainDeviceIdentityOption is false', () => {
    const withoutRtnDeviceIdentity = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const, // Removes CalibrationDate as expected
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'On' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withoutRtnDeviceIdentity)
    verifyNoErrors(result)

    const mappings = result.mapResults.mappings

    // Verify all device-related elements are cleaned according to their basicProfile
    deviceElements.forEach((element) => {
      // When retainDeviceIdentityOption is false, all device elements should be cleaned
      if (mappings[element.keyword]) {
        // Should be deleted or replaced according to its basicProfile
        expect(['replace', 'delete']).toContain(mappings[element.keyword][1])
        // The reason should be PS3.15E
        expect(mappings[element.keyword][2]).toBe('PS3.15E')
      }
    })
  })

  // Value representation types for temporal data
  const temporalVrTypes = ['DA', 'DT', 'TM'] as const
  type TemporalVRType = (typeof temporalVrTypes)[number]

  it('removes all temporal VR elements when retainLongitudinalTemporalInformationOptions is Off', () => {
    const expectedValues = {
      // Dummy values that replace original values
      DA: '99991231',
      DT: '99991231235959.999999',
      TM: '235959.999999',
    }

    const withoutTemporalData = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Off' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'On' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withoutTemporalData)
    verifyNoErrors(result)

    const dict = result.dicomData.dict
    const meta = result.dicomData.meta

    // Define allowed values for 'Off' option
    const getAllowedValues = (vr: TemporalVRType) => {
      return ['', undefined, expectedValues[vr]]
    }

    // Helper function to check temporal VR elements in a section
    const checkTemporalVRElements = (section: Record<string, any>) => {
      for (const tagId in section) {
        const element = section[tagId]
        if (temporalVrTypes.includes(element.vr as TemporalVRType)) {
          const value = element.Value?.[0] as string | undefined
          if (value === undefined) {
            // For 'Off' option, undefined is an allowed value
            expect(true).toBe(true)
          } else {
            const allowedValues = getAllowedValues(element.vr as TemporalVRType)
            expect(allowedValues.includes(value)).toBe(true)
          }
        }
      }
    }

    // Check all elements in dict and meta
    checkTemporalVRElements(dict)
    checkTemporalVRElements(meta)

    // Verify that none of the expected temporal values appear in the mappings
    Object.values(result.mapResults.mappings).forEach((mapping) => {
      const valueToMap = mapping[0] as string

      // Check if this value matches any of our expected temporal values
      const isTemporalValue = Object.values(expectedValues).includes(valueToMap)

      if (isTemporalValue) {
        // For Off retention, temporal values should be replaced, not deleted
        const operation = mapping[1] as string
        expect(operation).toBe('replace')
        expect(mapping[3]).not.toBeNull()
      }
    })
  })

  it('keeps all temporal data when retainLongitudinalTemporalInformationOptions is Full', () => {
    // Only values for this VR types in sample data
    const expectedValues = {
      DA: '20250101',
      DT: '20250101123000.000000',
      TM: '123000.000000',
    }

    const withTemporalData = {
      ...defaultTestOptions,
      curationSpec: specWithOptions({
        dicomPS315EOptions: {
          cleanDescriptorsOption: false,
          cleanDescriptorsExceptions: [],
          retainLongitudinalTemporalInformationOptions: 'Full' as const,
          retainPatientCharacteristicsOption: [],
          retainDeviceIdentityOption: false,
          retainUIDsOption: 'On' as const,
          retainSafePrivateOption: 'Off',
          retainInstitutionIdentityOption: false,
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withTemporalData)
    verifyNoErrors(result)

    const dict = result.dicomData.dict
    const meta = result.dicomData.meta

    // Define allowed values for 'Full' option
    const getAllowedValues = (vr: TemporalVRType) => {
      return [expectedValues[vr]]
    }

    // Helper function to check temporal VR elements in a section
    const checkTemporalVRElements = (section: Record<string, any>) => {
      for (const tagId in section) {
        const element = section[tagId]
        if (temporalVrTypes.includes(element.vr as TemporalVRType)) {
          const value = element.Value?.[0] as string | undefined
          if (value !== undefined) {
            const allowedValues = getAllowedValues(element.vr as TemporalVRType)
            expect(allowedValues.includes(value)).toBe(true)
          } else if (value === undefined) {
            fail(`Unexpected undefined value for tag ${tagId}`)
          }
        }
      }
    }

    // Check all elements in dict and meta
    checkTemporalVRElements(dict)
    checkTemporalVRElements(meta)

    // Verify that none of the expected temporal values appear in the mappings
    Object.values(result.mapResults.mappings).forEach((mapping) => {
      const valueToMap = mapping[0] as string

      // Check if this value matches any of our expected temporal values
      const isTemporalValue = Object.values(expectedValues).includes(valueToMap)

      if (isTemporalValue) {
        // For Full retention, temporal values should not appear in mappings at all
        fail(
          `Found temporal value "${valueToMap}" in mappings. With 'Full' retention, it should be preserved and not appear in mappings.`,
        )
      }
    })
  })

  it.each([
    {
      description: 'trailing spaces',
      value: '20250101123000.000000 ',
      expectedOffsetDateTime: '20260304163506.000000',
    },
    {
      description: 'leading spaces',
      value: ' 20250101123000.000000',
      expectedOffsetDateTime: '20260304163506.000000',
    },
    {
      description: 'both leading and trailing spaces',
      value: ' 20250101123000.000000 ',
      expectedOffsetDateTime: '20260304163506.000000',
    },
    {
      description: 'no leading or trailing spaces',
      value: '20250101123000.000000',
      expectedOffsetDateTime: '20260304163506.000000',
    },
  ])(
    'successfully offsets RadiopharmaceuticalStartDateTime with $description',
    ({ value, expectedOffsetDateTime }) => {
      const dateOffset = 'P1Y2M3DT4H5M6S' // 1 year, 2 months, 3 days, 4 hours, 5 minutes, 6 seconds

      // Create a modified sample with spaces in RadiopharmaceuticalStartDateTime
      const sampleWithSpaces = {
        ...sample,
        dict: {
          ...sample.dict,
          '00181078': {
            vr: 'DT',
            Value: [value], // Use the parameterised value with spaces
          },
        },
      }

      const withOffsetTemporalData = {
        ...defaultTestOptions,
        curationSpec: specWithOptions({
          dicomPS315EOptions: {
            cleanDescriptorsOption: false,
            cleanDescriptorsExceptions: [],
            retainLongitudinalTemporalInformationOptions: 'Offset' as const,
            retainPatientCharacteristicsOption: [],
            retainDeviceIdentityOption: false,
            retainUIDsOption: 'On' as const,
            retainSafePrivateOption: 'Off',
            retainInstitutionIdentityOption: false,
          },
        }),
        dateOffset,
      }

      const result = curateDict(
        passingFilename,
        sampleWithSpaces,
        withOffsetTemporalData,
      )
      verifyNoErrors(result)

      // Verify that RadiopharmaceuticalStartDateTime (00181078) is preserved and correctly offset
      verifyDicomTagIsPreserved(result, '00181078', expectedOffsetDateTime)

      // Verify that the original value (with spaces) appears in mappings as a replacement
      const mappings = result.mapResults.mappings
      const radiopharmMapping = mappings['RadiopharmaceuticalStartDateTime']
      expect(radiopharmMapping).toBeDefined()
      expect(radiopharmMapping[0]).toBe(value) // Original value with spaces
      expect(radiopharmMapping[1]).toBe('replace')
      expect(radiopharmMapping[2]).toBe('offsetTemporalOpt')
      expect(radiopharmMapping[3]).toBe(expectedOffsetDateTime) // Correctly offset value
    },
  )

  it('preserves private tags when retainSafePrivateOption is Quarantine', () => {
    // Use sampleBatchCurationSpecification with quarantine mode
    const batchSpec = sampleBatchCurationSpecification()
    const withQuarantineSpec = {
      ...defaultTestOptions,
      curationSpec: () => ({
        ...batchSpec,
        dicomPS315EOptions: {
          ...((batchSpec.dicomPS315EOptions as any) || {}),
          retainSafePrivateOption: 'Quarantine' as const,
        },
        // Disable DICOM header modifications for cleaner testing
        modifyDicomHeader(parser) {
          return {}
        },
      }),
    }

    const result = curateDict(passingFilename, sample, withQuarantineSpec)
    verifyNoErrors(result)

    // Verify private tags are quarantined
    const quarantine = result.mapResults.quarantine
    expect(quarantine).toBeDefined()
    expect('00051100' in quarantine).toBe(true)
    expect('GeneralMatchingSequence[0].00510014' in quarantine).toBe(true)

    // Verify private tags are preserved in the final DICOM data
    const dict = result.dicomData.dict

    // Check top-level private tag
    expect(dict['00051100']).toBeDefined()
    expect(dict['00051100'].vr).toBe('SH')
    expect(dict['00051100'].Value).toEqual(['Test Private Tag'])

    // Check nested private tag in sequence - handle different structures
    expect(dict['00080413']).toBeDefined()
    const sequence = dict['00080413']
    const sequenceItem = sequence.Value
      ? sequence.Value[0]
      : (sequence as any)[0]

    expect(sequenceItem).toBeDefined()
    expect(sequenceItem['00510014']).toBeDefined()
    expect(sequenceItem['00510014'].vr).toBe('ST')
    expect(sequenceItem['00510014'].Value).toEqual(['Test Private Tag'])

    // Verify that private tags are NOT in the mappings (they should be preserved, not modified)
    const mappings = result.mapResults.mappings
    expect('00051100' in mappings).toBe(false)
    expect('GeneralMatchingSequence[0].00510014' in mappings).toBe(false)
  })
})
