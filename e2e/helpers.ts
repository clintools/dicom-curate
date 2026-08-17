import type { OrganizeOptions, TCurationSpecification } from '../src/types'
import { createWorkspace as createSharedWorkspace } from '../testutils/workspace'

// Workspace and directory helpers are shared with the integration suite; see
// testutils/workspace.ts.
export {
  assertInputOutputDisjoint,
  hashDirectoryFiles,
  listFilesRecursive,
  type Workspace,
} from '../testutils/workspace'

import {
  assertInputOutputDisjoint,
  INPUT_DIR_NAME,
} from '../testutils/workspace'

export function createWorkspace() {
  return createSharedWorkspace('dicom-curate-e2e-')
}

// The specs below hard-code `input/...` because spec functions are serialized
// to the worker and cannot close over variables. Fail loudly if the workspace
// layout ever stops matching that literal.
if (INPUT_DIR_NAME !== 'input') {
  throw new Error(
    `e2e specs hard-code 'input/...' but INPUT_DIR_NAME is '${INPUT_DIR_NAME}'`,
  )
}

/**
 * Minimal spec: path-aware layout under study/subject/.
 *
 * The leading `input` is required: scanned paths are relative to the scan
 * root's parent, so omitting it shifts every `getFilePathComp` lookup by one
 * and silently returns the wrong segment rather than erroring.
 */
export function pathOrganizedSmokeSpec(): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    hostProps: { protocolNumber: 'e2e-smoke' },
    inputPathPattern: 'input/study/subject',
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
    inputPathPattern: 'input/study/subject',
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
      // Uses filename only; batch fixtures must have unique basenames (no subdirs).
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
