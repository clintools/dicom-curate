import { mkdir, writeFile } from 'fs/promises'
import fetch from 'node-fetch' // If you're on Node 18+, you can use the built-in global fetch
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
 * Fetches the DocBook XML for DICOM Part 05.
 */
async function fetchDocbookPart05XML() {
  const url =
    'https://dicom.nema.org/medical/dicom/current/source/docbook/part05/part05.xml'
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch part05.xml: ${response.status} ${response.statusText}`,
    )
  }
  return response.text()
}

/**
 * Recursively searches the parsed XML object to find a <table> element
 * with the specified xml:id.
 */
function findTableById(node, id) {
  if (!node || typeof node !== 'object') return null

  if (node.table) {
    if (!Array.isArray(node.table)) {
      if (node.table['xml:id'] === id) {
        return node.table
      }
    } else {
      for (const tbl of node.table) {
        if (tbl['xml:id'] === id) {
          return tbl
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    const child = node[key]
    if (typeof child === 'object') {
      const result = findTableById(child, id)
      if (result) return result
    }
  }
  return null
}

/**
 * Extracts text content from a node.
 */
function extractText(node) {
  if (!node) return ''
  if (typeof node === 'string') return node.trim()
  if (node._) return node._.trim()
  return ''
}

/**
 * Extracts all paragraph texts from a cell.
 */
function extractParas(cell) {
  if (!cell || typeof cell !== 'object') return []
  let paras = []
  if (cell.para) {
    if (Array.isArray(cell.para)) {
      paras = cell.para
    } else {
      paras = [cell.para]
    }
  }
  return paras.map((p) => extractText(p)).filter(Boolean)
}

/**
 * Parses the VR table (Table 6.2-1) from the DocBook XML.
 *
 * Handles two possible structures:
 *   1. Multiple <td> cells in a <tr>: first cell is code, second cell is name.
 *   2. A single <td> cell containing two <para> elements: first para is code, second is name.
 */
function parseVRTable(table) {
  let rows = []
  if (table.tbody && table.tbody.tr) {
    rows = Array.isArray(table.tbody.tr) ? table.tbody.tr : [table.tbody.tr]
  } else {
    throw new Error('No <tr> elements found in the VR table.')
  }

  const results = []
  for (const row of rows) {
    let cells = []
    if (row.td) {
      cells = Array.isArray(row.td) ? row.td : [row.td]
    } else if (row.entry) {
      cells = Array.isArray(row.entry) ? row.entry : [row.entry]
    } else {
      continue
    }

    // If only one cell, try to extract two <para> elements from it.
    const paras = extractParas(cells[0])
    if (paras.length >= 2) {
      const code = paras[0]
      const name = paras[1]
      if (code && name) {
        results.push({ code, name })
      }
    }
  }
  return results
}

async function main() {
  try {
    // Ensure the output directory exists.
    await mkdir(configDir, { recursive: true })

    // 1) Download the DocBook XML.
    const docbookXML = await fetchDocbookPart05XML()

    // 2) Parse the XML.
    const xmlObj = await parseStringPromise(docbookXML, {
      explicitArray: false,
      mergeAttrs: true,
    })

    // 3) Locate the VR table, which is Table 6.2-1.
    const vrTable = findTableById(xmlObj, 'table_6.2-1')
    if (!vrTable) {
      throw new Error(
        'Could not find <table xml:id="table_6.2-1"> in the DocBook XML.',
      )
    }

    // 4) Extract the VR data.
    const vrData = parseVRTable(vrTable)
    if (vrData.length === 0) {
      throw new Error('No VR data found in the table.')
    }

    // 5) Build the JavaScript content.
    const generatedOn = new Date().toISOString()
    const objectEntries = vrData
      .map(
        ({ code, name }) =>
          `  '${code}': { name: '${name.replace(/'/g, "\\'")}' }`,
      )
      .join(',\n')

    const jsContent = `// Auto-generated file containing DICOM Part 05 Table 6.2-1 (DICOM Value Representations)
// Generated on: ${generatedOn}
// Source: https://dicom.nema.org/medical/dicom/current/source/docbook/part05/part05.xml

export const vrsPS3_05_6_2_1 = {
${objectEntries}
} as const;
`

    // 6) Write the JS file.
    const outputFile = join(configDir, 'vrsPS3_05_6_2_1.ts')
    await writeFile(outputFile, jsContent, 'utf8')

    console.log(`Successfully generated: ${outputFile}`)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

// Execute the main function if the script is run directly.
main()
