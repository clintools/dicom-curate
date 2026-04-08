import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const srcDir = join(__dirname, '..', 'src')
const configDir = join(srcDir, 'config', 'dicom')

const targetFilename = 'retainAdditionalIds.ts'

/**
 * Fetches a DICOM standard file from the innolitics/dicom-standard repository.
 *
 * @param {string} filename - The name of the file to fetch.
 * @returns {Promise<object>} A promise resolving to the JSON contents of the file.
 */
async function fetchDicomStandard(filename) {
  const url = `https://raw.githubusercontent.com/innolitics/dicom-standard/master/standard/${filename}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Generates the DICOM elements profile.
 */
async function main() {
  try {
    // Ensure the configuration directory exists
    await mkdir(configDir, { recursive: true })

    // Fetch all DICOM elements
    let allElements = await fetchDicomStandard('attributes.json')

    // Fix name mistake in PS3.6
    allElements = allElements.map((el) => {
      if (el.name.includes('GenerationMode')) {
        return {
          ...el,
          name: el.name.replace('GenerationMode', 'Generation Mode'),
        }
      }
      return el
    })

    // Some tags that *could* occur in DICOM headers even though they
    // should be file meta header.
    // Workaround: We add Affected SOP Instance UID because we need it
    // for the name mapping. It occurs in PS3.15E. It is PS3.07, not PS3.06
    allElements.push(
      ...[
        {
          tag: '(0000,1000)',
          name: 'Affected SOP Instance UID',
          keyword: 'AffectedSOPInstanceUID',
          valueRepresentation: 'UI',
          valueMultiplicity: '1',
          retired: 'N',
          id: '00001000',
        },
        {
          tag: '(0000,1001)',
          name: 'Requested SOP Instance UID',
          keyword: 'RequestedSOPInstanceUID',
          valueRepresentation: 'UI',
          valueMultiplicity: '1',
          retired: 'N',
          id: '00001001',
        },
      ],
    )

    // Fetch the DICOM elements to anonymize
    let ps315EElements = await fetchDicomStandard(
      'confidentiality_profile_attributes.json',
    )

    // Standardize on keywords as names.
    // TODO: duplicate code. with other scripts
    ps315EElements = ps315EElements
      .filter((el) => el.name !== 'Private Attributes')
      .map(({ name, rtnDevIdOpt, ...rest }) => {
        // Fix an error in PS3.15E1.1 where some "of" are written "Of"
        name = name.replaceAll(' Of ', ' of ').replace(/\n.*/s, '')

        const elDef = allElements.find((el) => el.name === name)

        const updatedEl = { name, keyword: elDef.keyword, ...rest }

        // Fix that BeamHoldTransitionDateTime erroneously features rtnDevIdOpt
        return name === 'Beam Hold Transition DateTime'
          ? updatedEl
          : { ...updatedEl, rtnDevIdOpt }
      })

    const ps315Map = new Map(
      ps315EElements.map((element) => [element.tag, element]),
    )

    const additionalIdsSet = new Set()

    // Create a set of elements to preserve (using keywords)
    for (const element of allElements) {
      console.log(element.keyword)
      if (
        !ps315Map.has(element.tag) &&
        element.keyword.match(/[^U]IDs?$/) &&
        // UIDs are handled by retainUIDsOption
        element.valueRepresentation !== 'UI'
      ) {
        additionalIdsSet.add(element.keyword)
      }
    }

    // Manually selected a few that we should retain on `rtnDevIdOpt == true`
    // Note: Didn't check if they are UIDs, but it doesn't change anything.
    const toRetainIds = new Set([
      'RepairID',
      'DeviceID',
      'DisplaySubsystemID',
      'DegreeOfFreedomID',
    ])

    // Create the JavaScript content for the element names to always keep
    const tsContent = `// Auto-generated file containing DICOM non-UID IDs beyond PS3.15E.1 to handle
// Generated on: ${new Date().toISOString()}

/*
 * A value of \`false\` means, don't retain.
 * A value of { rtnDevIdOpt: true } means retain if the corresponding option is
 * selected
 */
export const retainAdditionalIds: {
  [keyword: string]: false | { rtnDevIdOpt: true }
} = {
  ${[...additionalIdsSet].map((e) => `${e}: ${toRetainIds.has(e) ? '{ rtnDevIdOpt: true }' : 'false'}`).join(',\n  ')}
}
`

    // Write the JavaScript file
    await writeFile(join(configDir, targetFilename), tsContent)

    console.log('\n\nSuccessfully generated:')
    console.log(`- ${targetFilename}.ts`)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

main()
