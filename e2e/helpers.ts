import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { OrganizeOptions, TCurationSpecification } from '../src/types'

/** Fail fast when input and output trees could collide. */
export function assertInputOutputDisjoint(
  inputDir: string,
  outputDir: string,
): void {
  const input = resolve(inputDir)
  const output = resolve(outputDir)
  if (
    input === output ||
    input.startsWith(`${output}/`) ||
    output.startsWith(`${input}/`)
  ) {
    throw new Error(
      `Input and output directories must not overlap (input=${input}, output=${output})`,
    )
  }
}

export function createWorkspace(): {
  inputDir: string
  outputDir: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'dicom-curate-e2e-'))
  const inputDir = join(base, 'input')
  const outputDir = join(base, 'output')
  mkdirSync(inputDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  assertInputOutputDisjoint(inputDir, outputDir)
  return {
    inputDir,
    outputDir,
    cleanup: () => {
      if (existsSync(base)) {
        rmSync(base, { recursive: true, force: true })
      }
    },
  }
}

export function hashDirectoryFiles(root: string): Map<string, string> {
  const hashes = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        const rel = relative(root, full)
        const digest = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex')
        hashes.set(rel, digest)
      }
    }
  }
  if (existsSync(root)) {
    walk(root)
  }
  return hashes
}

export function listFilesRecursive(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        files.push(relative(root, full))
      }
    }
  }
  if (existsSync(root)) {
    walk(root)
  }
  return files.sort()
}

/** Minimal spec: path-aware layout under study/subject/. */
export function pathOrganizedSmokeSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'e2e-smoke' },
    inputPathPattern: 'study/subject',
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      'curated',
      parser.getFilePathComp('subject'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })
}

/** PS3.15 de-id enabled; same path layout as pathOrganizedSmokeSpec. */
export function ps315SmokeSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'e2e-ps315' },
    inputPathPattern: 'study/subject',
    dicomPS315EOptions: {
      cleanDescriptorsOption: true,
      cleanDescriptorsExceptions: false,
      retainLongitudinalTemporalInformationOptions: 'Off',
      retainPatientCharacteristicsOption: false,
      retainDeviceIdentityOption: false,
      retainUIDsOption: 'Off',
      retainSafePrivateOption: 'Off',
      retainInstitutionIdentityOption: false,
    },
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      'curated',
      parser.getFilePathComp('subject'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })
}

/** Minimal spec for flat input trees (e.g. batch fixture dirs). */
export function flatSmokeSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'e2e-smoke-flat' },
    inputPathPattern: '',
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => {
      const parent = parser.getFilePathComp(-2)
      return [parent || 'files', parser.getFilePathComp(parser.FILENAME)]
    },
    errors: () => [],
  })
}

export function baseCurateOptions(
  inputDir: string,
  outputDir: string,
  curationSpec: OrganizeOptions['curationSpec'],
): OrganizeOptions {
  assertInputOutputDisjoint(inputDir, outputDir)
  return {
    inputType: 'path',
    inputDirectory: inputDir,
    outputDirectory: outputDir,
    curationSpec,
    workerCount: 1,
  }
}
