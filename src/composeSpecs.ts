/**
 * dicom-curate spec composer (runtime multi-spec, input order)
 */
import { specVersion } from '../src/config/specVersion'
import { defaultSpec } from './defaultSpec'
import { defaultPs315Options } from './deidentifyPS315E'
import type {
  TCurationSpecification,
  TPs315Options,
  HostProps,
} from '../src/types'
import type { TParser } from '../src/types'

type RetainOpt = string[] | false

type Ctx = Record<string, unknown>

type Ps315Chain = [TPs315Options | 'Off', ...(Partial<TPs315Options> | 'Off')[]]

export type SpecPart<T extends HostProps = HostProps, C extends Ctx = Ctx> = (
  ctxIn: C,
) => {
  ctx?: C
  spec?: Partial<TCurationSpecification<T>> & { version: string }
}

function concatUnique<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])]
}

/*
 * Only call for defined second argument
 */
function mergeRetain(a: RetainOpt | undefined, b: RetainOpt): RetainOpt {
  if (b === false) return false // cur takes precedence
  // b is array
  if (a === false || a === undefined) return [...b] // false -> array (take cur array)
  return concatUnique(a, b)
}

function isObj(v: unknown): v is HostProps {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)
  )
}

/*
 * merge hostProps: deep merge, arrays replace
 */
function mergeHostProps(
  prev: HostProps,
  next: HostProps | undefined,
): HostProps {
  if (!next) return prev
  if (!prev) return next

  const res: HostProps = { ...prev }

  for (const [k, v] of Object.entries(next)) {
    const pv = res[k]

    if (Array.isArray(v)) {
      res[k] = v
    } else if (isObj(v) && isObj(pv)) {
      res[k] = mergeHostProps(pv, v)
    } else {
      res[k] = v
    }
  }
  return res
}

/*
 * Merge PS3.15 options with special rules
 * We can accept partial Ps315 definitions, it will be merged with defaults.
 * So completeness of spec is in the callers responsibility.
 */
function mergePs315(chain: Ps315Chain): TPs315Options | 'Off' {
  let acc = chain[0]

  for (let i = 1; i < chain.length; i++) {
    let cur = chain[i]

    if (cur === undefined) continue

    if (cur === 'Off') {
      acc = 'Off'
      continue
    }

    if (acc === 'Off' || acc === undefined) {
      // restart from current, but only set specials if defined
      // Fill up items missing in cur with defaults.
      acc = { ...defaultPs315Options, ...cur }

      if (Array.isArray(cur.cleanDescriptorsExceptions)) {
        acc.cleanDescriptorsExceptions = [...cur.cleanDescriptorsExceptions]
      }

      const curRetain = cur.retainPatientCharacteristicsOption

      if (Array.isArray(curRetain)) {
        acc.retainPatientCharacteristicsOption = [...curRetain]
      }

      continue
    }

    // both are objects: apply field rules
    // Store arrays before spread overwrites them
    const prevCleanDesc = acc.cleanDescriptorsExceptions ?? []
    const prevRetainPatChars = acc.retainPatientCharacteristicsOption

    acc = { ...acc, ...cur }

    if (cur.cleanDescriptorsExceptions !== undefined) {
      acc.cleanDescriptorsExceptions = mergeRetain(
        prevCleanDesc,
        cur.cleanDescriptorsExceptions,
      )
    }

    if (cur.retainPatientCharacteristicsOption !== undefined) {
      acc.retainPatientCharacteristicsOption = mergeRetain(
        prevRetainPatChars,
        cur.retainPatientCharacteristicsOption,
      )
    }
  }

  return acc
}

type PartialVersionedSpec = { version: string } & Partial<
  Omit<TCurationSpecification, 'dicomPS315EOptions'> & {
    dicomPS315EOptions: Partial<TPs315Options> | 'Off'
  }
>

function isTCurationSpec(
  s: PartialVersionedSpec | SpecPart,
): s is PartialVersionedSpec {
  return typeof s !== 'function'
}

/*
 * Allow composeSpecs to receive
 * a single spec => no-op
 * an array of specs => first item is a complete spec, others are incremental definitions,
 * either as SpecPart or regular spec.
 */
export function composeSpecs(
  specOrComposedSpec:
    | PartialVersionedSpec
    | (PartialVersionedSpec | SpecPart)[],
): TCurationSpecification {
  // We always get TCurationSpecification | (PartialVersionedSpec | SpecPart)[]

  const specsIn = Array.isArray(specOrComposedSpec)
    ? specOrComposedSpec
    : [specOrComposedSpec]

  // Create a fresh copy of defaultSpec to prevent mutation of the global object
  let final: TCurationSpecification = {
    ...defaultSpec,
    modifyDicomHeader: defaultSpec.modifyDicomHeader,
    outputFilePathComponents: defaultSpec.outputFilePathComponents,
    errors: defaultSpec.errors,
    hostProps: { ...defaultSpec.hostProps },
    excludedFiletypes: defaultSpec.excludedFiletypes
      ? [...defaultSpec.excludedFiletypes]
      : [],
    dicomPS315EOptions: defaultSpec.dicomPS315EOptions,
  }

  if (specsIn.length === 0) {
    throw new Error('composeSpecs requires a non-empty spec array')
  }

  const ctx: HostProps = {}

  let ps315Chain: Ps315Chain = [final.dicomPS315EOptions]

  for (const specIn of specsIn) {
    // Convert spec to identical representation.
    let { ctx: c = {}, spec = { version: specVersion } } = isTCurationSpec(
      specIn,
    )
      ? { spec: specIn }
      : specIn(ctx)

    Object.assign(ctx, c)

    // version: all equal
    if (spec.version !== specVersion) {
      throw new Error(
        `All curation specification versions must be '${specVersion}'`,
      )
    }

    // hostProps: deep merge, arrays replace
    final.hostProps = mergeHostProps(final.hostProps, spec.hostProps)
    // inputPathPattern: latter wins
    final.inputPathPattern = spec.inputPathPattern ?? final.inputPathPattern

    if (spec.dicomPS315EOptions) {
      ps315Chain.push(spec.dicomPS315EOptions)
    }

    if (spec.excludedFiletypes !== undefined) {
      // merge
      const prev = [...(final.excludedFiletypes ?? [])]
      const next = spec.excludedFiletypes
      final.excludedFiletypes = [...prev, ...next]
    }

    // additionalData: latter wins (replace)
    if (spec.additionalData !== undefined) {
      final.additionalData = spec.additionalData
    }

    if (spec.modifyDicomHeader) {
      // merge but latter wins
      const prev = final.modifyDicomHeader
      const next = spec.modifyDicomHeader
      final.modifyDicomHeader = (p) => ({ ...prev(p), ...next(p) })
    }

    // Latter wins
    if (spec.outputFilePathComponents) {
      final.outputFilePathComponents = spec.outputFilePathComponents
    }

    // Accumulate errors
    if (spec.errors) {
      const prev = final.errors
      const next = spec.errors
      final.errors = (p: TParser) => {
        return [...prev(p), ...next(p)]
      }
    }
  }

  // dicomPS315EOptions: handle 'Off' vs object with special array rules
  final.dicomPS315EOptions = mergePs315(ps315Chain)

  return final
}
