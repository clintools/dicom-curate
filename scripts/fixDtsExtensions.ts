/**
 * Post-process emitted declaration files so that every relative import/export
 * specifier carries an explicit `.js` extension.
 *
 * Why this is needed
 * ------------------
 * `package.json` declares `"type": "module"`, so the published types describe an
 * ES module. `tsc` copies relative specifiers into the emitted `.d.ts` files
 * verbatim and never adds extensions. Consumers that use
 * `moduleResolution: "node16" | "nodenext"` then fail with TS2834
 * ("Relative import paths need explicit file extensions") because raw Node ESM
 * resolution does not guess extensions.
 *
 * The runtime JS in `dist/esm` is produced by esbuild with `bundle: true`, so it
 * is unaffected. Only the declaration files need fixing, and we do it here rather
 * than littering the source tree with `.js` extensions.
 *
 * What it does
 * ------------
 * Walks every `.d.ts` under `dist/types` and, for each relative specifier in
 * `import ... from '...'`, `export ... from '...'` and dynamic `import('...')`:
 *   - leaves it alone if it already ends in `.js`, `.json`, `.cjs` or `.mjs`;
 *   - rewrites it to `<specifier>/index.js` when the target resolves to a
 *     directory containing an `index.d.ts`;
 *   - otherwise appends `.js`.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'types',
)

// Matches the specifier in `from '...'` / `from "..."` and `import('...')`.
// Group 1 = quote+specifier prefix we keep, group 2 = specifier, group 3 = closing quote.
const SPECIFIER_RE = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)(['"])/g

const ALREADY_HAS_EXT = /\.(js|cjs|mjs|json)$/

function rewriteSpecifier(fileDir: string, specifier: string): string {
  if (ALREADY_HAS_EXT.test(specifier)) return specifier

  // Does the specifier point at a directory with an index.d.ts?
  const asDir = resolve(fileDir, specifier)
  if (existsSync(asDir) && statSync(asDir).isDirectory()) {
    return `${specifier}/index.js`
  }
  return `${specifier}.js`
}

function processFile(filePath: string): boolean {
  const fileDir = dirname(filePath)
  const original = readFileSync(filePath, 'utf8')
  const updated = original.replace(
    SPECIFIER_RE,
    (
      _match,
      prefix: string,
      openQuote: string,
      specifier: string,
      closeQuote: string,
    ) => {
      const rewritten = rewriteSpecifier(fileDir, specifier)
      return `${prefix}${openQuote}${rewritten}${closeQuote}`
    },
  )
  if (updated !== original) {
    writeFileSync(filePath, updated)
    return true
  }
  return false
}

function* walkDts(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDts(full)
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

function main() {
  if (!existsSync(TYPES_DIR)) {
    console.error(
      `fixDtsExtensions: ${TYPES_DIR} does not exist; run after tsc.`,
    )
    process.exit(1)
  }
  let changed = 0
  let scanned = 0
  for (const filePath of walkDts(TYPES_DIR)) {
    scanned++
    if (processFile(filePath)) changed++
  }
  console.log(
    `fixDtsExtensions: scanned ${scanned} declaration file(s), rewrote ${changed}.`,
  )
}

main()
