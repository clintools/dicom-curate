import { TColumnMappings, TMappedValues, Row } from './csvMapping'
import type { TNaturalData } from 'dcmjs'
import type { SpecPart } from './composeSpecs'

export type Iso8601Duration = string

export type TPs315Options = {
  cleanDescriptorsOption: boolean
  cleanDescriptorsExceptions: false | string[]
  retainLongitudinalTemporalInformationOptions: 'Full' | 'Off' | 'Offset'
  retainPatientCharacteristicsOption: false | string[]
  retainDeviceIdentityOption: boolean
  retainUIDsOption: 'On' | 'Off' | 'Hashed'
  retainSafePrivateOption: 'Off' | 'Quarantine'
  retainInstitutionIdentityOption: boolean
}

export type TFileInfoIndex = Record<
  // Original file path/name
  // For postMappedHash, we also look up by output file path/name
  string,
  {
    size?: number
    mtime?: string
    preMappedHash?: string
    postMappedHash?: string
  }
>

export type OrganizeOptions = {
  outputDirectory?: FileSystemDirectoryHandle | string
  outputEndpoint?: THTTPOptions | TS3BucketOptions
  curationSpec: () => TCurationSpecification | SpecPart[]
  table?: Row[]
  skipWrite?: boolean
  skipModifications?: boolean
  skipValidation?: boolean
  dateOffset?: Iso8601Duration
  // If true, the TMapResults values will not be accumulated and
  // will be only returned one by one in progress messages.
  // Only anomalies results will be returned by curateMany() and the final
  // 'done' progress message.
  skipCollectingMappings?: boolean
  // Hash algorithm to use when calculating & comparing original and mapped file hashes.
  // Used in conjunction with fileInfoIndex.
  // Defaults to 'crc64'.
  hashMethod?: THashMethod
  // optional previous file info map keyed by "path/name"
  // if set, used to determine if mapping can be skipped for files that appear unchanged
  fileInfoIndex?: TFileInfoIndex
  // Optional glob patterns to exclude files by path during scanning.
  // Patterns are matched against the full file path (e.g., S3 object key, or
  // relative path from the input directory root).
  // Example: ['**/logs/**'] excludes any file under a 'logs' directory.
  // Uses picomatch glob syntax.
  excludedPathGlobs?: string[]
} & (
  | { inputType: 'directory'; inputDirectory: FileSystemDirectoryHandle }
  | { inputType: 'files'; inputFiles: File[] }
  | { inputType: 'path'; inputDirectory: string }
  | {
      inputType: 'http'
      inputUrls: string[]
      headers?: Record<string, string> | THTTPHeaderProvider
    }
  | { inputType: 's3'; inputS3Bucket: TS3BucketOptions }
)

export type THashMethod = 'crc64' | 'crc32' | 'sha256' | 'md5'

// Function that provides HTTP headers
// Useful when headers contain authorization tokens that may expire
// and curateMany() is long-running
export type THTTPHeaderProvider = () =>
  | Promise<Record<string, string>>
  | Record<string, string>

export type THTTPOptions = {
  // Target URL for upload - target file path is appended to this base URL
  url: string
  // Additional headers to include in HTTP requests
  headers?: Record<string, string> | THTTPHeaderProvider
}

export type TS3BucketOptions = {
  bucketName: string
  region?: string
  // Optional prefix to prepend to all uploaded object keys
  prefix?: string
  // Optional additional metadata to include with each uploaded object
  metadata?: Record<string, string>
  // Optional AWS credentials - if not provided, will use default SDK credentials resolution
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
  // Optional S3 endpoint, commonly used for S3-compatible storage services
  endpoint?: string
  // If true, will use path-style addressing for S3 objects
  forcePathStyle?: boolean
}

export type TMappingOptions = {
  columnMappings?: TColumnMappings
  curationSpec: () => TCurationSpecification | SpecPart[]
  skipWrite?: boolean
  skipModifications?: boolean
  skipValidation?: boolean
  dateOffset?: Iso8601Duration
}

export type TSerializedMappingOptions = Omit<
  TMappingOptions,
  'curationSpec'
> & {
  curationSpecStr: string
}

export type TFileInfo = {
  path: string
  name: string
  size: number
  mtime?: string
  preMappedHash?: string
  postMappedHash?: string
} & (
  | { kind: 'handle'; fileHandle: FileSystemFileHandle }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'path'; fullPath: string }
  | {
      kind: 'http'
      url: string
      headers?: Record<string, string> | THTTPHeaderProvider
    }
  | { kind: 's3'; bucketOptions: TS3BucketOptions; objectKey: string }
)

// Includes deep sequences
type TAttr = { [name: string]: string | TAttr[] }

export type TMapResults = {
  sourceInstanceUID: string
  // may be omitted if no file has been written
  outputFilePath?: string
  // optional information about the source file (size, name, path, mtime)
  fileInfo?: {
    name: string
    size: number
    path: string
    mtime?: string
    // present when parsing failed
    parseError?: string
    preMappedHash?: string
    postMappedHash?: string
  }
  // optional hashes for input/output state
  // SHA-256 hex string of the file read from disk prior to mapping
  // and of the file after mapping
  // these will be present in fileInfo for traceability

  mappings: {
    // objectpath: deep object access string compatible with lodash get/set
    // TAttr[]: exclude individual { key: value } objects
    [objectPath: string]:
      | [string, 'replace', string, string | TAttr[]]
      | [string, 'delete', string, undefined]
  }
  anomalies: string[]
  errors: string[]
  quarantine: { [objectPath: string]: string }
  listing?: {
    info: TMappingTwoPassInfo[]
    collectByValue: [...TMappingTwoPassCollect, string | number][]
  }
  mappedBlob?: Blob
  // Optional info when the mapped output was uploaded to a remote target
  outputUpload?: { url: string; status: number }
  // If true, mapping was skipped because the file appears unchanged from previous run
  // New semantics: mappingRequired indicates that mapping must be applied.
  // This replaces the old `noMappingRequired` flag (inverted semantics).
  mappingRequired?: boolean
  // Time in ms for curation logic
  curationTime?: number
}

export type TPs315EElement = {
  name: string
  keyword: string
  tag: string
  stdCompIOD: 'Y' | 'N'
  id: string
  basicProfile: string
  cleanDescOpt?: string
  cleanStructContOpt?: string
  rtnLongFullDatesOpt?: string
  rtnLongModifDatesOpt?: string
  rtnUIDsOpt?: string
  rtnPatCharsOpt?: string
  rtnDevIdOpt?: string
  rtnInstIdOpt?: string
  cleanGraphOpt?: string
  rtnSafePrivOpt?: string
  // introduced by us
  exceptCondition?: (attrs: TNaturalData) => boolean
}

export type TParser = {
  getFrom(source: string, identifier: string): string | number
  getFilePathComp: (component: string | number | symbol) => string
  getMapping: ((value: string) => string | number) | undefined
  getDicom: (attrName: string) => any
  missingDicom: (attrName: string) => boolean
  protectUid: (uid: string) => string
  addDays: (dicomDateString: string, offsetDays: number) => string
  FILENAME: symbol
  FILEBASENAME: symbol
}

type TMappingInputDirect = {
  // load: csv file
  type: 'load'
  collect: Record<string, RegExp | string[]>
}

type TMappingTwoPassInfo = [name: string, value: string]
type TMappingTwoPassCollect = [
  value: string,
  format: RegExp | string[],
  lookupField: string,
]

type TMappingInputTwoPass = {
  // two-pass: extract from listing.
  type: 'listing'
  collect: (
    parser: Pick<TParser, 'getDicom' | 'getFilePathComp' | 'getFrom'>,
  ) => {
    lookups: { [lookupField: string]: string }
    info: TMappingTwoPassInfo[]
    collect: TMappingTwoPassCollect[]
  }
}

type HPPrimitive = string | number | boolean | null | RegExp
export type HPValue = HPPrimitive | { [k: string]: HPValue } | HPValue[]

export type HostProps = Record<string, HPValue>

export type TCurationSpecification<THost extends HostProps = HostProps> = {
  version: string
  modifyDicomHeader: (parser: TParser) => { [keyword: string]: string }
  outputFilePathComponents: (parser: TParser) => string[]
  errors: (parser: TParser) => [message: string, failure: boolean][]
  dicomPS315EOptions: TPs315Options | 'Off'
  inputPathPattern: string
  hostProps: THost
  additionalData?: { mapping: TMappedValues } & (
    | TMappingInputDirect
    | TMappingInputTwoPass
  )
  excludedFiletypes?: string[]
}

type TProgressMessageBase = {
  totalFiles?: number
  processedFiles?: number
}

type TProgressMessageProgress = TProgressMessageBase & {
  response: 'progress'
  mapResults?: TMapResults
  error?: Error
}

export type TProgressMessageDone = TProgressMessageBase & {
  response: 'done'
  mapResultsList: TMapResults[]
}

export type TProgressMessage = TProgressMessageProgress | TProgressMessageDone

// Kept here, because it is also imported from the worker
export const OUTPUT_FILE_PREFIX = 'output#'
