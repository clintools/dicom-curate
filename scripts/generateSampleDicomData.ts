import type { DicomDataset, TDicomData } from 'dcmjs'
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { allElements } from '../testdata/allElements'
import dummyTestValues from '../testdata/dummyTestValues'

function getValueForVR(
  id: string,
  vr: string,
  valueMultiplicity: string,
): any[] {
  // Get the base value for this VR type
  const baseValue = dummyTestValues[vr]

  // Parse the VM to get minimum number
  const minVM = parseInt(valueMultiplicity.split('-')[0])

  // Handle special cases for SQ (Sequence) type, add sequence with private tag to GeneralMatchingSequence (0008,0413)
  if (vr === 'SQ') {
    if (id === '00080413') {
      return [baseValue[1]] // Nested private tag
    } else {
      return [baseValue[0]]
    }
  }
  // For all other VR types
  return Array(minVM).fill(baseValue)
}

function generateDicomData(): TDicomData {
  const meta: DicomDataset = {}
  const dict: DicomDataset = {}

  // Add private tag
  dict['00051100'] = {
    vr: 'SH',
    Value: ['Test Private Tag'],
  }

  allElements.forEach((attr) => {
    // Skip if no VR defined or VR is 'See Note 2'
    if (
      !attr.valueRepresentation ||
      attr.valueRepresentation === '' ||
      attr.valueRepresentation === 'See Note 2'
    ) {
      return
    }
    // Convert 'US or SS' and 'US or SS or OW' to 'US'
    if (
      attr.valueRepresentation === 'US or SS' ||
      attr.valueRepresentation === 'US or SS or OW' ||
      attr.valueRepresentation === 'US or OW'
    ) {
      attr.valueRepresentation = 'US'
    }
    // Convert 'OB or OW' to 'OB'
    if (attr.valueRepresentation === 'OB or OW') {
      attr.valueRepresentation = 'OB'
    }

    const id = attr.id
    const vr = attr.valueRepresentation
    const vm = attr.valueMultiplicity
    // Create the DICOM element
    const element = {
      vr: vr,
      Value: getValueForVR(id, vr, vm),
    }
    // Add to appropriate section based on tag
    if (id.startsWith('0002')) {
      meta[id] = element
    } else {
      dict[id] = element
    }
  })
  return { meta, dict }
}

// Generate the data
const sample: TDicomData = generateDicomData()

// Get the directory name in ES module scope
const __dirname = dirname(fileURLToPath(import.meta.url))

// Create the TypeScript file content
const fileContent = `import type { TDicomData } from 'dcmjs'
export const sample: TDicomData = ${JSON.stringify(sample, null, 2)} as const;
export default sample;
`

// Write the data to a TypeScript file
const outputPath = join(__dirname, '../testdata/sample.ts')
writeFileSync(outputPath, fileContent, 'utf8')

// Log a success message
console.log(`DICOM data has been generated and written to ${outputPath}`)

// Export the data
export default sample
