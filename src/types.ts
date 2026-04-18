import type { TNaturalData } from 'dcmjs'
import type { SpecPart } from './composeSpecs'
import type { Row, TColumnMappings, TMappedValues } from './csvMapping'

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
  curationSpec: (() => TCurationSpecification | SpecPart[]) | NoneSpecification
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
  // Defaults to 'md5'.
  hashMethod?: THashMethod
  // Part size (in bytes) used by the upstream S3 multipart upload.
  // Only relevant when hashMethod is 'aws-s3-etag-2025': files larger than
  // this threshold produce a composite ETag-style hash; smaller files produce
  // a plain MD5. Defaults to 5 * 1024 * 1024 (5 MB), matching the
  // @aws-sdk/lib-storage Upload class default.
  hashPartSize?: number
  // optional previous file info map keyed by "path/name"
  // if set, used to determine if mapping can be skipped for files that appear unchanged
  fileInfoIndex?: TFileInfoIndex
  // Optional glob patterns to exclude files by path during scanning.
  // Patterns are matched against the full file path (e.g., S3 object key, or
  // relative path from the input directory root).
  // Example: ['**/logs/**'] excludes any file under a 'logs' directory.
  // Uses picomatch glob syntax.
  excludedPathGlobs?: string[]
  // Maximum number of concurrent mapping workers.
  // Defaults to the platform's hardware concurrency (capped at 8).
  // Reducing this limits peak memory usage at the cost of slower throughput.
  workerCount?: number
  // Optional AbortSignal to cancel processing. When aborted, all workers are
  // hard-terminated and curateMany rejects with a DOMException (name: 'AbortError').
  // Equivalent to reloading the page — partially written files are detected and
  // re-processed on the next run via the hash-based fileInfoIndex check.
  signal?: AbortSignal
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

export type THashMethod =
  | 'crc64'
  | 'crc32'
  | 'sha256'
  | 'md5'
  // Matches S3 ETag format: plain MD5 for single-part uploads, composite
  // md5(concat(md5(part1)...md5(partN)))-N for multipart uploads.
  // Uses hashPartSize to determine the part boundary (defaults to 5 MB).
  // The multipart ETag algorithm is undocumented by AWS but empirically
  // stable since ~2006 for SSE-S3 (AES256) encrypted objects.
  | 'aws-s3-etag-2025'

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

/** Output target for curation -- at most one of http, directory, or s3. */
export type TOutputTarget = {
  http?: THTTPOptions
  directory?: FileSystemDirectoryHandle | string
  s3?: TS3BucketOptions
}

export type TMappingOptions = {
  columnMappings?: TColumnMappings
  curationSpec: (() => TCurationSpecification | SpecPart[]) | NoneSpecification
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
  /** Upload/write failures only (retryable). Separate from `errors` which
   *  contains DICOM validation issues that cannot be resolved by retrying. */
  uploadErrors?: string[]
  quarantine: { [objectPath: string]: string }
  listing?: {
    info: TMappingTwoPassInfo[]
    collectByValue: [...TMappingTwoPassCollect, string | number][]
  }
  mappedBlob?: Blob
  // Optional info when the mapped output was uploaded to a remote target
  outputUpload?: { url: string; status: number; etag?: string }
  // If true, mapping was skipped because the file appears unchanged from previous run
  // New semantics: mappingRequired indicates that mapping must be applied.
  // This replaces the old `noMappingRequired` flag (inverted semantics).
  mappingRequired?: boolean
  // Set when the file was excluded by a preExclude or postExclude in the curation spec.
  // 'pre': excluded before mapping (original tags); 'post': excluded after output path computed.
  excluded?: 'pre' | 'post'
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

// Parser passed to postExclude — same as TParser but with the computed output path attached.
// Use parser.outputFilePath to access the output path; parser.getFilePathComp() still
// returns input path components (as in preExclude).
export type TPostExcludeParser = TParser & {
  outputFilePath: string
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

type HPPrimitive =
  | string
  | number
  | boolean
  | null
  | RegExp
  | ((...args: any[]) => any)
export type HPValue = HPPrimitive | { [k: string]: HPValue } | HPValue[]

export type HostProps = Record<string, HPValue>

export type NoneSpecification = 'none'

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
  // Called with original (pre-mapping) DICOM tags. Return true to exclude (skip) the file.
  //
  // Example — skip files whose Patient ID doesn't match the expected format:
  //   preExclude: (parser) => !/^AB\d{2}-\d{3}$/.test(parser.getDicom('PatientID')),
  preExclude?: (parser: TParser) => boolean
  // Called after the output path is computed and PS315E de-identification has run.
  // parser.getDicom() returns de-identified tag values at this point.
  // Use parser.outputFilePath to access the computed output path.
  // Return true to exclude (skip) writing/uploading the file.
  //
  // Example — skip files mapped into an 'exclude' output folder, or with an unwanted modality:
  //   postExclude: (parser) =>
  //     parser.outputFilePath.includes('/exclude/') || parser.getDicom('Modality') === 'SR',
  postExclude?: (parser: TPostExcludeParser) => boolean
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
