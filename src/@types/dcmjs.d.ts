declare module 'dcmjs' {
  export type TDicomDataValue = any[]
  /**/
  /* prettier-ignore */
  export type TVR = string
  export interface DicomJsonElement {
    vr: TVR
    Value?: Array<string | number | DicomDataset>
    BulkDataURI?: string
  }

  export interface DicomDataset {
    [tag: string]: DicomJsonElement
  }
  /**/

  export type TNaturalData = { [keyword: string]: any }
  export type TDicomData = {
    meta: DicomDataset
    dict: DicomDataset
  }
  export type TDicomDictionaryEntry = {
    tag: string // e.g., "00100010"
    vr: string // e.g., "PN"
    vm: string // e.g., "1"
    name: string // e.g., "PatientName"
    version: string
  }
  export type TDicomDictionary = {
    [tag: string]: TDicomDictionaryEntry
  }

  export namespace data {
    interface ReadFileOptions {
      ignoreErrors?: boolean
    }

    interface WriteOptions {
      allowInvalidVRLength?: boolean
    }

    interface AsyncDicomReaderOptions {
      isLittleEndian?: boolean
      clearBuffers?: boolean
      maxFragmentSize?: number
      listener?: any
    }

    interface AsyncReadFileOptions {
      ignoreErrors?: boolean
      listener?: any
      maxSizeMeta?: number
      untilOffset?: number
    }

    class ReadBufferStream {
      constructor(
        data: ArrayBuffer | null,
        isLittleEndian?: boolean,
        options?: any,
      )
      setData(data: ArrayBuffer): void
      setEndian(isLittleEndian: boolean): void
      ensureAvailable(size?: number): Promise<boolean>
    }

    class DicomDict {
      constructor(meta: DicomDataset)
      meta: DicomDataset
      dict: DicomDataset
      write(options?: WriteOptions): ArrayBuffer
      merge(other: DicomDict): void
    }

    class DicomMessage {
      constructor(arrayBuffer: ArrayBuffer)
      static readFile(
        fileArrayBuffer: ArrayBuffer,
        options?: ReadFileOptions,
      ): DicomDict
    }

    class AsyncDicomReader {
      constructor(options?: AsyncDicomReaderOptions)
      stream: ReadBufferStream
      meta: DicomDataset
      dict: DicomDataset
      syntax: string
      readFile(options?: AsyncReadFileOptions): Promise<AsyncDicomReader>
      readPreamble(): Promise<boolean | symbol>
      readMeta(options?: AsyncReadFileOptions): Promise<DicomDataset>
      read(listener: any, options?: AsyncReadFileOptions): Promise<any>
      readSequence(
        listener: any,
        sqTagInfo: any,
        options?: AsyncReadFileOptions,
      ): Promise<void>
      readTagHeader(options?: any): any
    }

    class DicomMetadataListener {
      constructor()
      information?: Record<string, any>
      addTag(tag: string, tagInfo: any): any
      value(val: any): void
      startObject(obj?: any): void
      pop(): any
    }

    class DicomMetaDictionary {
      static nameMap: {
        [keyWord: string]: {
          tag: string
          vr: string
          name: string
          vm: string
          version: string
        }
      }
      static uid(): string
      static dictionary: TDicomDictionary
      static getTagFromName(name: string): string
      static getNameFromTag(tag: string): string
      static getVR(tag: string): string
      static getDescription(tag: string): string
      static getVM(tag: string): string
      static getKeyword(tag: string): string
      static naturalizeDataset(
        dataset: Record<string, DicomJsonElement>,
      ): TNaturalData
      static denaturalizeDataset(
        dataset: TNaturalData,
      ): Record<string, DicomJsonElement>
    }

    function datasetToDict(
      dataset: DicomDataset,
    ): Record<string, DicomJsonElement>
    function datasetToBuffer(dataset: DicomDataset): ArrayBuffer
    function datasetToBlob(dataset: DicomDataset): Blob
  }

  export namespace log {
    /**
     * Sets the global logging level.
     * @param level - The desired logging level.
     */
    function setLevel(level: LogLevel): void

    /**
     * Retrieves a logger instance by name.
     * @param name - The name of the logger.
     * @returns A logger instance.
     */
    function getLogger(name: string): Logger

    /**
     * Enumeration of available log levels.
     */
    const levels: {
      TRACE: LogLevel
      DEBUG: LogLevel
      INFO: LogLevel
      WARN: LogLevel
      ERROR: LogLevel
      SILENT: LogLevel
    }
  }

  /**
   * Represents a logger with methods for various logging levels.
   */
  export interface Logger {
    setLevel(level: LogLevel): void
    trace(...msg: any[]): void
    debug(...msg: any[]): void
    info(...msg: any[]): void
    warn(...msg: any[]): void
    error(...msg: any[]): void
  }

  /**
   * Type representing the possible log levels.
   */
  export type LogLevel =
    | 'trace'
    | 'debug'
    | 'info'
    | 'warn'
    | 'error'
    | 'silent'
}
