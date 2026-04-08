import { mkdir, writeFile } from 'fs/promises'
import fetch from 'node-fetch' // If you're on Node 18+, you can use global fetch
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { parseStringPromise } from 'xml2js'

// Derive __dirname in ESM context
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Adjust these paths to match your folder layout
const srcDir = join(__dirname, '..', 'src')
const configDir = join(srcDir, 'config', 'dicom')

/**
 * Fetches the DocBook XML for DICOM PS3.6 (part06.xml).
 * @returns {Promise<string>} Raw XML content
 */
async function fetchDocbookPart06XML() {
  const url =
    'https://dicom.nema.org/medical/dicom/current/source/docbook/part06/part06.xml'
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch part06.xml: ${response.status} ${response.statusText}`,
    )
  }
  return response.text()
}

/**
 * Recursively searches the parsed XML object to find a <table> element
 * whose xml:id is "table_A-1".
 *
 * @param {object} node - Current XML node to search
 * @returns {object|null} The matching table object, or null if not found
 */
function findTableA1(node) {
  if (!node || typeof node !== 'object') return null

  // If this node has a "table" property that is an object
  if (node.table && !Array.isArray(node.table)) {
    // Check if the table has xml:id="table_A-1"
    if (node.table['xml:id'] === 'table_A-1') {
      return node.table
    }
  }

  // If this node has a "table" property that is an array
  if (Array.isArray(node.table)) {
    for (const tbl of node.table) {
      if (tbl['xml:id'] === 'table_A-1') {
        return tbl
      }
    }
  }

  // Otherwise, recurse into child properties
  for (const key of Object.keys(node)) {
    const child = node[key]
    if (typeof child === 'object') {
      const result = findTableA1(child)
      if (result) return result
    }
  }
  return null
}

/**
 * Extracts the text content from a <td> node that might contain <para> or <emphasis>.
 * @param {object} tdObj - The parsed td element
 * @returns {string} Trimmed text
 */
function extractCellText(tdObj) {
  if (!tdObj || typeof tdObj !== 'object') {
    return ''
  }

  // If there's direct text in tdObj._
  if (tdObj._) {
    return tdObj._.trim()
  }

  // If there's <para> child
  if (tdObj.para) {
    // direct text in para._
    if (tdObj.para._) {
      return tdObj.para._.trim()
    }
    // or <emphasis> text
    if (tdObj.para.emphasis && tdObj.para.emphasis._) {
      return tdObj.para.emphasis._.trim()
    }
  }

  return ''
}

/**
 * Parses <tbody><tr> from the table, extracting columns:
 *   Column[0] => UID Value
 *   Column[2] => UID Keyword
 *
 * @param {object} tableA1 - The table object with xml:id="table_A-1"
 * @returns {Array<{ uidValue: string, uidKeyword: string }>}
 */
function parseTableA1(tableA1) {
  // We expect <thead> and <tbody> under tableA1
  const tbody = tableA1.tbody
  if (!tbody || !tbody.tr) {
    throw new Error('No <tbody> or <tr> found in table_A-1.')
  }

  // The <tbody> should have multiple <tr>
  const rows = Array.isArray(tbody.tr) ? tbody.tr : [tbody.tr]

  const results = []
  for (const row of rows) {
    // Each row has multiple <td> elements
    const cells = Array.isArray(row.td) ? row.td : [row.td]
    // We need at least 3 columns to get columns 0 and 2
    if (cells.length < 3) continue

    const uidValue = extractCellText(cells[0]) // UID Value at col 0
    const uidKeyword = extractCellText(cells[2]) // UID Keyword at col 2

    if (uidValue && uidKeyword) {
      results.push({ uidValue, uidKeyword })
    }
  }
  return results
}

/**
 * Main function to:
 *  1) Fetch the DocBook XML,
 *  2) Find table_A-1,
 *  3) Parse columns 0 and 2 (UID Value, UID Keyword),
 *  4) Write a TypeScript file with the resulting array.
 */
async function main() {
  try {
    // Ensure config dir
    await mkdir(configDir, { recursive: true })

    // 1) Download the DocBook XML
    const docbookXML = await fetchDocbookPart06XML()

    // 2) Parse the XML into a JS object
    const xmlObj = await parseStringPromise(docbookXML, {
      explicitArray: false,
      mergeAttrs: true,
    })

    // 3) Locate the table with xml:id="table_A-1"
    const tableA1 = findTableA1(xmlObj)
    if (!tableA1) {
      throw new Error(
        'Could not find <table xml:id="table_A-1"> in the DocBook XML.',
      )
    }

    // 4) Extract the UID data
    const uidData = parseTableA1(tableA1)

    // 5) Build the TypeScript content
    const generatedOn = new Date().toISOString()
    const itemsString = uidData
      .map(
        ({ uidValue, uidKeyword }) =>
          `  '${uidValue}': '${uidKeyword.replace(/'/g, "\\'")}'`,
      )
      .join(',\n')

    const tsContent = `// Auto-generated file containing DICOM PS3.6 Table A-1 (UID Registry)
// Generated on: ${generatedOn}
//
// Columns: 0 => UID Value, 2 => UID Keyword
// Source: https://dicom.nema.org/medical/dicom/current/source/docbook/part06/part06.xml

export const uidRegistryPS3_06_A1 = {
${itemsString}
};
`

    // 6) Write the TS file
    const outputFile = join(configDir, 'uidRegistryPS3_06_A1.ts')
    await writeFile(outputFile, tsContent, 'utf8')

    console.log(`Successfully generated: ${outputFile}`)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

// Execute if invoked directly
main()
