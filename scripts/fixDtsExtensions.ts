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
 *   - appends `.js` when `<specifier>.d.ts` exists;
 *   - rewrites it to `<specifier>/index.js` when the target is a directory
 *     containing an `index.d.ts`;
 *   - otherwise records it as unresolved and fails the build, so a stale or
 *     mistyped relative import cannot silently ship a non-resolving `.d.ts`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'types',
)

// Matches the specifier in `from '...'` / `from "..."` and `import('...')`.
const SPECIFIER_RE = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)(['"])/g

const ALREADY_HAS_EXT = /\.(js|cjs|mjs|json)$/

// Resolve a relative specifier to its rewritten form, or `null` when it cannot
// be mapped to an emitted declaration. A sibling file is preferred over a
// same-named directory, matching how Node ESM resolves an explicit `./foo.js`.
function rewriteSpecifier(fileDir: string, specifier: string): string | null {
  if (ALREADY_HAS_EXT.test(specifier)) return specifier

  const target = resolve(fileDir, specifier)
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`
  if (existsSync(join(target, 'index.d.ts'))) return `${specifier}/index.js`
  return null
}

function processFile(filePath: string, unresolved: string[]): boolean {
  const fileDir = dirname(filePath)
  const original = readFileSync(filePath, 'utf8')
  const updated = original.replace(
    SPECIFIER_RE,
    (
      match: string,
      prefix: string,
      openQuote: string,
      specifier: string,
      closeQuote: string,
    ) => {
      const rewritten = rewriteSpecifier(fileDir, specifier)
      if (rewritten === null) {
        unresolved.push(`${filePath} -> ${specifier}`)
        return match
      }
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
  const unresolved: string[] = []
  let changed = 0
  let scanned = 0
  for (const filePath of walkDts(TYPES_DIR)) {
    scanned++
    if (processFile(filePath, unresolved)) changed++
  }

  if (unresolved.length > 0) {
    console.error(
      `fixDtsExtensions: ${unresolved.length} relative specifier(s) do not resolve to an emitted declaration:`,
    )
    for (const entry of unresolved) console.error(`  ${entry}`)
    console.error('Fix the corresponding relative import(s) in src/.')
    process.exit(1)
  }

  console.log(
    `fixDtsExtensions: scanned ${scanned} declaration file(s), rewrote ${changed}.`,
  )
}

main()
