import * as dcmjs from 'dcmjs'
import { curateOne } from './curateOne'
import { hash } from './hash'
import type {
  TCurationSpecification,
  TFileInfo,
  TMappingOptions,
} from './types'

describe('curateOne with none specification', () => {
  it('returns passthrough mapping results and skips DICOM parsing', async () => {
    const bytes = new TextEncoder().encode('not-a-dicom-file')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([bytes], { type: 'application/octet-stream' }),
      path: 'input/path',
      name: 'my test!.dcm',
      size: bytes.length,
    }

    const mappingOptions: TMappingOptions = {
      curationSpec: 'none',
      skipWrite: true,
    }

    const readFileSpy = vi.spyOn(dcmjs.data.DicomMessage, 'readFile')

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions,
    })

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(result.mappingRequired).toBe(false)
    expect(result.sourceInstanceUID).toContain('passthrough')
    expect(result.outputFilePath).toBe('input/path/my test!.dcm')
    expect(result.mappings).toEqual({})
    expect(result.anomalies).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.quarantine).toEqual({})
  })

  it('preserves bytes in passthrough mode when producing mappedBlob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 255])
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([bytes], { type: 'application/octet-stream' }),
      path: 'input',
      name: 'raw.bin',
      size: bytes.length,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: 'none', skipWrite: false },
    })

    const mappedBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    expect(Array.from(mappedBytes)).toEqual(Array.from(bytes))
    expect(result.mappingRequired).toBe(false)
  })
})

describe('curateOne byte-identical output when no header changes', () => {
  // A spec that parses the file but makes no DICOM header modifications:
  // de-identification is Off and modifyDicomHeader returns {}.
  const noOpSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  it('preserves original bytes when spec produces no DICOM header mappings', async () => {
    // Build a minimal but valid DICOM binary from scratch using dcmjs
    const dataset = {
      PatientName: 'Test',
      PatientID: 'P001',
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    const originalBuffer = dicomDict.write({ allowInvalidVRLength: true })
    const originalBytes = new Uint8Array(originalBuffer)

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([originalBuffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: originalBytes.length,
    }

    const mappingOptions: TMappingOptions = {
      curationSpec: noOpSpec,
      skipWrite: false,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions,
    })

    // The output should be byte-identical to the input
    const mappedBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    expect(Array.from(mappedBytes)).toEqual(Array.from(originalBytes))

    // Mapping was still evaluated (not skipped like canSkip or 'none')
    expect(result.mappingRequired).toBe(true)
    expect(Object.keys(result.mappings!)).toHaveLength(0)
  })
})

describe('curateOne skip paths', () => {
  const noOpSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  function buildDicomBuffer() {
    const dataset = {
      PatientName: 'Test',
      PatientID: 'P001',
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    return dicomDict.write({ allowInvalidVRLength: true })
  }

  it('includes postMappedHash in fileInfo for output-side skips', async () => {
    const buffer = buildDicomBuffer()

    // First pass: process the file to get the output hash
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const firstResult = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      hashMethod: 'md5',
    })

    const knownPostMappedHash = firstResult.fileInfo!.postMappedHash!
    expect(knownPostMappedHash).toBeDefined()

    // Second pass: provide previousMappedFileInfo that returns the same hash
    // This triggers the output-side skip (postMappedHash match)
    const fileInfo2: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const secondResult = await curateOne({
      fileInfo: fileInfo2,
      outputTarget: {},
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      hashMethod: 'md5',
      previousMappedFileInfo: async () => ({
        postMappedHash: knownPostMappedHash,
      }),
    })

    // Should be a skip (noMapResult path)
    expect(secondResult.mappingRequired).toBe(false)
    // Output file path should be present (output-side skip includes it)
    expect(secondResult.outputFilePath).toBeDefined()
    // postMappedHash should be present in fileInfo for output-side skips
    expect(secondResult.fileInfo!.postMappedHash).toBe(knownPostMappedHash)
  })

  it('does not include postMappedHash in fileInfo for input-side skips', async () => {
    const buffer = buildDicomBuffer()
    const preMappedHash = await hash(buffer, 'md5')

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: noOpSpec, skipWrite: true },
      hashMethod: 'md5',
      previousSourceFileInfo: {
        preMappedHash,
      },
    })

    // Should be a skip (input-side, via preMappedHash match)
    expect(result.mappingRequired).toBe(false)
    // Input-side skip does not know the output hash
    expect(result.fileInfo!.postMappedHash).toBeUndefined()
    // Input-side skip does not know the output file path
    expect(result.outputFilePath).toBeUndefined()
  })
})

describe('curateOne preExclude and postExclude', () => {
  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  function buildDicomBuffer(patientId = 'AB12-123') {
    const dataset = {
      PatientName: patientId,
      PatientID: patientId,
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    return dicomDict.write({ allowInvalidVRLength: true })
  }

  function makeSpec(
    overrides: Partial<TCurationSpecification> = {},
  ): () => TCurationSpecification {
    return () => ({
      inputPathPattern:
        'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
      version: '3.0',
      hostProps: {},
      dicomPS315EOptions: 'Off',
      modifyDicomHeader: () => ({}),
      outputFilePathComponents: (parser) => [
        parser.getFilePathComp('protocolNumber'),
        parser.getFilePathComp('activityProvider'),
        parser.getFilePathComp(parser.FILENAME),
      ],
      errors: () => [],
      ...overrides,
    })
  }

  it('returns excluded: pre and skips write when preExclude returns true', async () => {
    const buffer = buildDicomBuffer()
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({ preExclude: () => true }),
        skipWrite: false,
      },
    })

    expect(result.excluded).toBe('pre')
    expect(result.mappedBlob).toBeUndefined()
    expect(result.fileInfo).toBeDefined()
    expect(result.fileInfo!.name).toBe('test.dcm')
    expect(result.fileInfo!.size).toBe(buffer.byteLength)
  })

  it('returns excluded: post and skips write when postExclude returns true', async () => {
    const buffer = buildDicomBuffer()
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({ postExclude: () => true }),
        skipWrite: false,
      },
    })

    expect(result.excluded).toBe('post')
    expect(result.mappedBlob).toBeUndefined()
    expect(result.fileInfo).toBeDefined()
    expect(result.fileInfo!.name).toBe('test.dcm')
  })

  it('processes normally when preExclude returns false', async () => {
    const buffer = buildDicomBuffer()
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({ preExclude: () => false }),
        skipWrite: false,
      },
    })

    expect(result.excluded).toBeUndefined()
    expect(result.mappedBlob).toBeDefined()
    expect(result.mappingRequired).toBe(true)
  })

  it('passes original PatientID to preExclude before any mapping', async () => {
    const buffer = buildDicomBuffer('ORIGINAL_ID')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    let capturedId: string | undefined

    await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({
          preExclude: (parser) => {
            capturedId = parser.getDicom('PatientID')
            return false
          },
          // modifyDicomHeader replaces PatientID — preExclude must see the original
          modifyDicomHeader: () => ({ PatientID: 'REPLACED' }),
        }),
        skipWrite: false,
      },
    })

    expect(capturedId).toBe('ORIGINAL_ID')
  })

  it('passes computed output file path to postExclude', async () => {
    const buffer = buildDicomBuffer()
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    let capturedPath: string | undefined

    await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({
          outputFilePathComponents: () => ['out', 'subdir', 'result.dcm'],
          postExclude: (parser) => {
            capturedPath = parser.outputFilePath
            return false
          },
        }),
        skipWrite: false,
      },
    })

    expect(capturedPath).toContain('out/subdir/')
  })

  it('does not upload when postExclude excludes the file', async () => {
    const buffer = buildDicomBuffer()
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const mockFetch = vi.fn<typeof fetch>()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch

    try {
      const result = await curateOne({
        fileInfo,
        outputTarget: { http: { url: 'https://example.com/upload' } },
        mappingOptions: {
          curationSpec: makeSpec({ postExclude: () => true }),
          skipWrite: false,
        },
      })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.excluded).toBe('post')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('evaluates preExclude even when previousSourceFileInfo hash matches', async () => {
    const buffer = buildDicomBuffer()
    const preMappedHash = await hash(buffer, 'md5')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({ preExclude: () => true }),
        skipWrite: false,
      },
      hashMethod: 'md5',
      previousSourceFileInfo: { preMappedHash },
    })

    expect(result.excluded).toBe('pre')
  })

  it('evaluates postExclude even when previousSourceFileInfo hash matches', async () => {
    const buffer = buildDicomBuffer()
    const preMappedHash = await hash(buffer, 'md5')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: {
        curationSpec: makeSpec({ postExclude: () => true }),
        skipWrite: false,
      },
      hashMethod: 'md5',
      previousSourceFileInfo: { preMappedHash },
    })

    expect(result.excluded).toBe('post')
  })
})

describe('curateOne upload ETag capture', () => {
  const noOpSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  function buildDicomBuffer() {
    const dataset = {
      PatientName: 'Test',
      PatientID: 'P001',
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    return dicomDict.write({ allowInvalidVRLength: true })
  }

  it('captures ETag from HTTP upload response', async () => {
    const buffer = buildDicomBuffer()
    const mockEtag = '"d41d8cd98f00b204e9800998ecf8427e"'

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { ETag: mockEtag },
      }),
    )

    try {
      const fileInfo: TFileInfo = {
        kind: 'blob',
        blob: new Blob([buffer], { type: 'application/octet-stream' }),
        path: inputPath,
        name: 'test.dcm',
        size: buffer.byteLength,
      }

      const result = await curateOne({
        fileInfo,
        outputTarget: {
          http: {
            url: 'https://example.com/upload',
          },
        },
        mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
        hashMethod: 'md5',
      })

      expect(result.outputUpload).toBeDefined()
      expect(result.outputUpload!.status).toBe(200)
      expect(result.outputUpload!.etag).toBe(mockEtag)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sets etag to undefined when response has no ETag header', async () => {
    const buffer = buildDicomBuffer()

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))

    try {
      const fileInfo: TFileInfo = {
        kind: 'blob',
        blob: new Blob([buffer], { type: 'application/octet-stream' }),
        path: inputPath,
        name: 'test.dcm',
        size: buffer.byteLength,
      }

      const result = await curateOne({
        fileInfo,
        outputTarget: {
          http: {
            url: 'https://example.com/upload',
          },
        },
        mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
        hashMethod: 'md5',
      })

      expect(result.outputUpload).toBeDefined()
      expect(result.outputUpload!.etag).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('curateOne S3 output upload strategy', () => {
  const noOpSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  function buildDicomBuffer() {
    const dataset = {
      PatientName: 'Test',
      PatientID: 'P001',
      Modality: 'CT',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: '1.2.3.4.5.6.7.8.9',
      SeriesInstanceUID: '1.2.3.4.5.6.7.8',
      StudyInstanceUID: '1.2.3.4.5.6.7',
      SeriesNumber: '1',
    }
    const dicomDict = new dcmjs.data.DicomDict({
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020002': { vr: 'UI', Value: [dataset.SOPClassUID] },
      '00020003': { vr: 'UI', Value: [dataset.SOPInstanceUID] },
    })
    dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset)
    return dicomDict.write({ allowInvalidVRLength: true })
  }

  let mockUploadDone: ReturnType<typeof vi.fn>
  let mockUploadConstructor: ReturnType<typeof vi.fn>
  let curateOneFn: typeof curateOne

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    mockUploadDone = vi.fn()
    // Capture the constructor args so the test can assert partSize was
    // forwarded to lib-storage's Upload helper.
    mockUploadConstructor = vi.fn(() => ({ done: mockUploadDone }))

    vi.doMock('./s3Client', () => ({
      loadS3Client: vi.fn(async () => ({
        S3Client: vi.fn(() => ({ send: vi.fn() })),
        PutObjectCommand: vi.fn(),
      })),
    }))

    vi.doMock('./libStorage', () => ({
      loadLibStorage: vi.fn(async () => ({
        Upload: mockUploadConstructor,
      })),
    }))

    ;({ curateOne: curateOneFn } = await import('./curateOne'))
  })

  it('uses lib-storage with MAX_SAFE_INTEGER partSize when uploadPartSize is undefined', async () => {
    const buffer = buildDicomBuffer()
    mockUploadDone.mockResolvedValue({ ETag: '"plain-md5-etag"' })

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOneFn({
      fileInfo,
      outputTarget: {
        s3: {
          bucketName: 'my-bucket',
          region: 'us-east-1',
        },
      },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      hashMethod: 'md5',
    })

    expect(mockUploadConstructor).toHaveBeenCalledTimes(1)
    const constructorArgs = mockUploadConstructor.mock.calls[0]![0]
    // MAX_SAFE_INTEGER is the internal sentinel: lib-storage will fall back
    // to a single PutObject because no real file exceeds 2^53 - 1 bytes,
    // so S3 returns a plain-MD5 ETag.
    expect(constructorArgs.partSize).toBe(Number.MAX_SAFE_INTEGER)
    expect(constructorArgs.params.Bucket).toBe('my-bucket')
    expect(constructorArgs.params.Key).toBe(
      'Sample_Protocol_Number/Sample_CRO/CT_1.2.3.4.5.6.7.8.9.dcm',
    )
    expect(result.outputUpload).toBeDefined()
    expect(result.outputUpload!.etag).toBe('"plain-md5-etag"')
    expect(result.outputUpload!.url).toBe(
      's3://my-bucket/Sample_Protocol_Number/Sample_CRO/CT_1.2.3.4.5.6.7.8.9.dcm',
    )
  })

  it('uses lib-storage Upload with the given partSize when uploadPartSize is set', async () => {
    const buffer = buildDicomBuffer()
    mockUploadDone.mockResolvedValue({ ETag: '"multipart-composite-etag-2"' })

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOneFn({
      fileInfo,
      outputTarget: {
        s3: {
          bucketName: 'my-bucket',
          region: 'us-east-1',
          uploadPartSize: 5 * 1024 * 1024,
        },
      },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      hashMethod: 'md5',
    })

    expect(mockUploadConstructor).toHaveBeenCalledTimes(1)
    const constructorArgs = mockUploadConstructor.mock.calls[0]![0]
    expect(constructorArgs.partSize).toBe(5 * 1024 * 1024)
    expect(constructorArgs.params.Bucket).toBe('my-bucket')
    expect(constructorArgs.params.Key).toBe(
      'Sample_Protocol_Number/Sample_CRO/CT_1.2.3.4.5.6.7.8.9.dcm',
    )
    expect(mockUploadDone).toHaveBeenCalledTimes(1)
    expect(result.outputUpload).toBeDefined()
    expect(result.outputUpload!.etag).toBe('"multipart-composite-etag-2"')
  })

  it('records a lib-storage Upload failure in uploadErrors', async () => {
    const buffer = buildDicomBuffer()
    mockUploadDone.mockRejectedValue(new Error('network blew up'))

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }

    const result = await curateOneFn({
      fileInfo,
      outputTarget: {
        s3: {
          bucketName: 'my-bucket',
          region: 'us-east-1',
          uploadPartSize: 5 * 1024 * 1024,
        },
      },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      hashMethod: 'md5',
    })

    expect(result.outputUpload).toBeUndefined()
    expect(result.uploadErrors).toBeDefined()
    expect(result.uploadErrors!.length).toBeGreaterThan(0)
    expect(result.uploadErrors![0]).toContain('network blew up')
  })
})
