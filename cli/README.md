# DICOM Curate CLI

CLI for curating DICOM files: reads from an input directory, applies a **user-supplied curation spec** (header changes and output layout), and writes curated DICOMs to an output directory. The CLI is **spec-driven and directory-structure agnostic**—behavior and expected folder layout come entirely from the spec you pass.

## Usage

> **IMPORTANT:** run `pnpm build` before attempting to use the script

```bash
node cli/curate.js <input-directory> <output-directory> --spec <path-to-spec> [options]
```

### Arguments

| Argument           | Description                                         |
| ------------------ | --------------------------------------------------- |
| `input-directory`  | Directory containing DICOM files to curate          |
| `output-directory` | Directory where curated DICOM files will be written |

### Options

| Option                         | Description                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `-s, --spec <path>`            | **Required.** Path to a curation spec module (JS/ESM that exports a function returning a `TCurationSpecification`) |
| `-m, --output-mappings <file>` | Path to a file to save unique mappings applied during curation (JSON)                                              |

## Examples

Using the example spec in this repo (assumes `patient/study/series/file` under the input directory):

```bash
node cli/curate.js /data/CTHead /data/CTHead-deid -s cli/curation-spec.js
```

Save applied mappings to a JSON file:

```bash
node cli/curate.js /data/CTHead /data/CTHead-deid -s cli/curation-spec.js -m mappings.json
```

Using a custom spec (path relative to current working directory):

```bash
node cli/curate.js ./in ./out -s ./my-spec.js
```

## Where to get a spec

- **`cli/curation-spec.js`** — Minimal example in this repo: expects `patient/study/series/file` and maps path components to DICOM headers. Use as a template or for quick tests.
- **`testdata/sampleCurationSpecification.js`** — Generated from `src/config/sampleBatchCurationSpecification.ts` when you run `pnpm build`. Study/trial-oriented (protocol, activity provider, center subject, timepoint, scan). Use for batch/trial workflows.
- **`src/config/`** — Source of truth for sample specs (TypeScript). Not directly runnable by the CLI; the build emits JS to `testdata/`. Use these as reference or extend them; for CLI use the built file or your own JS spec.
- **Your own module** — Any ESM module that exports a function returning a curation spec (same shape as the library’s `TCurationSpecification`). Can be flat, nested, or study-specific.
