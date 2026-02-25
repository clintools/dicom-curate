#!/usr/bin/env node
/* eslint-env node */

import { curateMany } from 'dicom-curate'
import { Command } from 'commander'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const program = new Command()

program
  .name('dicom-curate-cli')
  .description('CLI tool for DICOM curation')
  .version('1.0.0')
  .argument('<input-directory>', 'Directory containing DICOM files to curate')
  .argument(
    '<output-directory>',
    'Directory where curated DICOM files will be written',
  )
  .requiredOption(
    '-s, --spec <path>',
    'Path to a curation spec module (JS/ESM that exports a function returning a TCurationSpecification)',
  )
  .option(
    '-m, --output-mappings <file>',
    'Path to a file to save unique mappings applied during curation',
  )

program.parse(process.argv)

const args = program.args
const options = program.opts()

const inputDirectory = args[0]
const outputDirectory = args[1]
const specPath = options.spec
const outputMappingsFile = options.outputMappings

async function loadCurationSpec(specPathArg) {
  const resolved = resolve(process.cwd(), specPathArg)
  const url = pathToFileURL(resolved).href
  const mod = await import(url)
  const fn = mod.default ?? mod.sampleBatchCurationSpecification ?? mod
  if (typeof fn !== 'function') {
    throw new Error(
      `Spec at ${specPathArg} must export a function (default or named) that returns a curation spec.`,
    )
  }
  return fn
}

const errors = []
function onProgressCallback(progress) {
  const percent = Math.round(
    (progress.processedFiles / progress.totalFiles) * 100,
  )

  // A repeating NaN indicates the process is stuck. We can avoid polluting the console.
  if (isNaN(percent)) {
    return
  }

  // Use process.stdout.write to create a single, updating progress line.
  process.stdout.write(`Progress: ${percent}% \r`)

  if (progress.error) {
    // Log errors on a new line to avoid overwriting the progress bar
    const errorMessage = `\nError processing ${progress.error.fileInfo.name}: ${progress.error.message}`
    console.error(errorMessage)
    errors.push(errorMessage)
  }
}

async function main() {
  const specFn = await loadCurationSpec(specPath)
  const curationOptions = {
    inputType: 'path',
    inputDirectory,
    outputDirectory,
    curationSpec: () => specFn(),
  }

  console.log(`Starting curation...`)
  console.log(`- Input directory: ${inputDirectory}`)
  console.log(`- Output directory: ${outputDirectory}`)
  console.log(`- Spec: ${specPath}`)
  if (outputMappingsFile) {
    console.log(`- Output mappings file: ${outputMappingsFile}`)
  }

  const { mapResultsList } = await curateMany(
    curationOptions,
    onProgressCallback,
  )

  process.stdout.write('\n')
  console.log('Curation complete.')

  if (outputMappingsFile && mapResultsList) {
    try {
      await writeFile(
        outputMappingsFile,
        JSON.stringify(mapResultsList, null, 2),
      )
      console.log(`Unique mappings saved to ${outputMappingsFile}`)
    } catch (writeErr) {
      console.error(
        `Error saving unique mappings to ${outputMappingsFile}:`,
        writeErr,
      )
    }
  }
  if (errors && errors.length > 0) {
    console.error('\nErrors occurred during curation:')
    errors.forEach((error) => {
      console.error(`- ${error}`)
    })
  }
}

main().catch((err) => {
  console.error('\nAn unexpected error occurred:', err)
  process.exit(1)
})
