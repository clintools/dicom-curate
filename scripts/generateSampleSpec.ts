#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import prettier from 'prettier'
import ts from 'typescript'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ——— Paths ———
const tsSourcePath = join(
  __dirname,
  '..',
  'src',
  'config',
  'sampleBatchCurationSpecification.ts',
)
const jsOutPath = join(
  __dirname,
  '..',
  'testdata',
  'sampleCurationSpecification.js',
)
const readmePath = join(__dirname, '..', 'README.md')

// ——— Read the TS source file ———
const tsSource = readFileSync(tsSourcePath, 'utf8').trim()

// ——— Prep snippet version: witch to dicom-curate import and drop comments ———
const snippetSource = tsSource.replace(
  /^import type \{ TCurationSpecification \} from ['"][^'"]+['"]\s*;?/m,
  "import type { TCurationSpecification } from 'dicom-curate'\n\n",
)

// ——— 1) Generate the JS module via transpilation ———
let jsOutput = ts.transpileModule(tsSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    removeComments: false,
    alwaysStrict: false,
  },
}).outputText

jsOutput = await prettier.format(jsOutput, {
  parser: 'babel',
  semi: false,
  tabWidth: 2,
  singleQuote: true,
})

writeFileSync(jsOutPath, jsOutput, 'utf8')
console.log(`✅ Generated ${jsOutPath}`)

// ——— 2) Sync only the *annotated* README snippet ———
const readme = readFileSync(readmePath, 'utf8')
const relativeInput = relative(join(__dirname, '..'), tsSourcePath)
const MARKER = `<!-- Snippet auto-generated from ${relativeInput} -->`

// — wrap that full script in your README snippet, using TS fences
const replacement = `${MARKER}

\`\`\`ts
${snippetSource}
\`\`\``

// — locate & replace the old fenced snippet
const escaped = MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fenceRe = new RegExp(escaped + '[\\s\\S]*?```ts[\\s\\S]*?```', 'm')

if (fenceRe.test(readme)) {
  const updated = readme.replace(fenceRe, replacement)
  writeFileSync(readmePath, updated, 'utf8')
  console.log(`✅ Updated code snippet in ${readmePath}`)
} else {
  console.warn(
    `⚠️ No README snippet marker found ("${MARKER}"), skipping update.`,
  )
}
