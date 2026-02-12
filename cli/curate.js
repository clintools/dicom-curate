#!/usr/bin/env node

import { curateMany } from 'dicom-curate';
// Load a simple curation spec from a local file for this proof of concept.
import curationSpec from './curation-spec.js';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';

const program = new Command();

program
  .name('dicom-curate-cli')
  .description('CLI tool for DICOM curation')
  .version('1.0.0') // You might want to link this to your package.json version
  .argument('<input-directory>', 'Directory containing DICOM files to curate')
  .argument('<output-directory>', 'Directory where curated DICOM files will be written')
  .option('-m, --output-mappings <file>', 'Path to a file to save unique mappings applied during curation');

program.parse(process.argv);

const args = program.args;
const options = program.opts();

const inputDirectory = args[0];
const outputDirectory = args[1];
const outputMappingsFile = options.outputMappings;

// Commander.js handles missing required arguments by displaying help and exiting.
// No need for a manual check here.

const curationOptions = {
  inputType: 'path',
  inputDirectory,
  outputDirectory,
  curationSpec,
  // columnMapping can be added here if needed, for example by reading a CSV file from an option.
};

const errors = [];
function onProgressCallback(progress) {
  const percent = Math.round(
    (progress.processedFiles / progress.totalFiles) * 100,
  );

  // A repeating NaN indicates the process is stuck. We can avoid polluting the console.
  if (isNaN(percent)) {
    return;
  }

  // Use process.stdout.write to create a single, updating progress line.
  process.stdout.write(`Progress: ${percent}% \r`);

  if (progress.error) {
    // Log errors on a new line to avoid overwriting the progress bar
    const errorMessage = `\nError processing ${progress.error.fileInfo.name}: ${progress.error.message}`;
    console.error(errorMessage);
    errors.push(errorMessage);
  }
}

console.log(`Starting curation...`);
console.log(`- Input directory: ${inputDirectory}`);
console.log(`- Output directory: ${outputDirectory}`);
if (outputMappingsFile) {
  console.log(`- Output mappings file: ${outputMappingsFile}`);
}

curateMany(curationOptions, onProgressCallback)
  .then(async ({ mapResultsList }) => {
    // Ensure the "Curation complete." message appears on a new line after the progress bar.
    process.stdout.write('\n');
    console.log('Curation complete.');

    if (outputMappingsFile && mapResultsList) {
      try {
        await writeFile(
          outputMappingsFile,
          JSON.stringify(mapResultsList, null, 2),
        );
        console.log(`Unique mappings saved to ${outputMappingsFile}`);
      } catch (writeErr) {
        console.error(
          `Error saving unique mappings to ${outputMappingsFile}:`,
          writeErr,
        );
      }
    }
    if (errors && errors.length > 0) {
      console.error('\nErrors occurred during curation:');
      errors.forEach((error) => {
        console.error(`- ${error}`);
      });
    }
  })
  .catch(err => {
    console.error('\nAn unexpected error occurred:', err);
    process.exit(1);
  });