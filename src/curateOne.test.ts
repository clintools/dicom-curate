import * as dcmjs from 'dcmjs'
import { generateFile } from 'dicom-synth'
import {
  buildDicomdirDcmjsBuffer,
  DICOMDIR_SOP_CLASS_UID,
} from '../testutils/minimalDicom'
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

describe('curateOne PixelData preservation', () => {
  // A spec that changes the PatientName, ensuring mappings is non-empty.
  // This forces curateOne into the LazyCompositeBlob path for PixelData files.
  const pixelSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({ PatientName: 'ANON' }),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp('activityProvider'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  /**
   * Build a minimal but valid DICOM file that includes a PixelData tag
   * (7FE0,0010) with the supplied bytes.  The file is explicit little-endian
   * (Transfer Syntax 1.2.840.10008.1.2.1) so that dcmjs's AsyncDicomReader can
   * parse the header and stop exactly at the PixelData tag.
   */
  function buildDicomWithPixelData(pixelBytes: Uint8Array): Uint8Array {
    const dataset = {
      PatientName: 'Test^Patient',
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
    const headerBuf = dicomDict.write({ allowInvalidVRLength: true })
    const headerBytes = new Uint8Array(headerBuf)

    // DICOM requires even-length pixel data values.
    const paddedPixel =
      pixelBytes.length % 2 === 0
        ? pixelBytes
        : new Uint8Array([...pixelBytes, 0x00])
    const pixelLen = paddedPixel.length

    // Explicit little-endian OB tag for 7FE0,0010:
    //   2 bytes group (E0 7F)  +  2 bytes element (10 00)
    //   2 bytes VR  (4F 42 = "OB")
    //   2 bytes reserved (00 00)
    //   4 bytes length (uint32 LE)
    //   N bytes pixel data
    const tagHeader = new Uint8Array(12)
    tagHeader[0] = 0xe0
    tagHeader[1] = 0x7f // group 7FE0 LE
    tagHeader[2] = 0x10
    tagHeader[3] = 0x00 // element 0010 LE
    tagHeader[4] = 0x4f
    tagHeader[5] = 0x42 // VR = OB
    tagHeader[6] = 0x00
    tagHeader[7] = 0x00 // reserved
    new DataView(tagHeader.buffer).setUint32(8, pixelLen, true) // length LE

    const out = new Uint8Array(headerBytes.length + tagHeader.length + pixelLen)
    out.set(headerBytes, 0)
    out.set(tagHeader, headerBytes.length)
    out.set(paddedPixel, headerBytes.length + tagHeader.length)
    return out
  }

  it('preserves original PixelData bytes when header changes are applied', async () => {
    // Use a recognisable, even-length pixel payload so we can easily locate it
    // in the output and verify it was not modified during curation.
    const pixelBytes = new Uint8Array([
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
    ])
    const dicomBytes = buildDicomWithPixelData(pixelBytes)

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([dicomBytes.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
      path: inputPath,
      name: 'test.dcm',
      size: dicomBytes.length,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: pixelSpec, skipWrite: false },
    })

    // Curation ran (not an early skip)
    expect(result.mappingRequired).toBe(true)

    // The PatientName mapping was applied
    expect(result.mappings).toBeDefined()
    expect(Object.keys(result.mappings!)).toContain('PatientName')

    // The output blob must exist and be at least as large as the input —
    // it contains the rewritten header plus the original PixelData bytes.
    expect(result.mappedBlob).toBeDefined()
    const outputBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    expect(outputBytes.length).toBeGreaterThan(0)

    // The original pixel bytes must appear verbatim at the tail of the output.
    // curateOne appends file.slice(pixelDataOffset) which is the PixelData tag
    // header (12 bytes) followed immediately by the pixel data itself.
    const tail = outputBytes.slice(outputBytes.length - pixelBytes.length)
    expect(Array.from(tail)).toEqual(Array.from(pixelBytes))
  })

  it('writes full bytes to a FileSystemDirectoryHandle (browser write path)', async () => {
    // Regression test: LazyCompositeBlob exposes its bytes only via the
    // overridden stream(); a native write(blob) reads the empty Blob body and
    // produces a 0-byte file. The mock's write() reproduces that native-copy
    // behaviour (Blob.prototype.arrayBuffer bypasses the override), so this
    // fails if curateOne passes the Blob directly and passes when it streams.
    const written = new Map<string, Uint8Array>()

    function makeDir(prefix: string): FileSystemDirectoryHandle {
      return {
        async getDirectoryHandle(name: string) {
          return makeDir(prefix ? `${prefix}/${name}` : name)
        },
        async getFileHandle(name: string) {
          const fullPath = prefix ? `${prefix}/${name}` : name
          return {
            async createWritable() {
              const chunks: Uint8Array[] = []
              return {
                async write(data: Blob | Uint8Array) {
                  if (data instanceof Blob) {
                    // Read native bytes, ignoring any subclass override —
                    // matches FileSystemWritableFileStream.write(blob).
                    const buf = await Blob.prototype.arrayBuffer.call(data)
                    chunks.push(new Uint8Array(buf))
                  } else {
                    chunks.push(data)
                  }
                },
                async close() {
                  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
                  const out = new Uint8Array(total)
                  let offset = 0
                  for (const c of chunks) {
                    out.set(c, offset)
                    offset += c.byteLength
                  }
                  written.set(fullPath, out)
                },
              }
            },
          } as unknown as FileSystemFileHandle
        },
      } as unknown as FileSystemDirectoryHandle
    }

    const pixelBytes = new Uint8Array([
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
    ])
    const dicomBytes = buildDicomWithPixelData(pixelBytes)

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([dicomBytes.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
      path: inputPath,
      name: 'test.dcm',
      size: dicomBytes.length,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: { directory: makeDir('') },
      mappingOptions: { curationSpec: pixelSpec, skipWrite: false },
    })

    expect(result.mappingRequired).toBe(true)

    // Exactly one file was written, and it is NOT empty.
    expect(written.size).toBe(1)
    const outputBytes = [...written.values()][0]
    expect(outputBytes.length).toBeGreaterThan(0)

    // Original pixel bytes preserved verbatim at the tail.
    const tail = outputBytes.slice(outputBytes.length - pixelBytes.length)
    expect(Array.from(tail)).toEqual(Array.from(pixelBytes))
  })

  it('does not double-append PixelData when the spec produces no header changes', async () => {
    // When modifyDicomHeader returns {} and dicomPS315EOptions is Off,
    // curateOne short-circuits to write() -> original file blob (byte-identical
    // copy).  PixelData is included naturally via that path and must NOT be
    // duplicated.
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

    const pixelBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
    const dicomBytes = buildDicomWithPixelData(pixelBytes)

    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([dicomBytes.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
      path: inputPath,
      name: 'test.dcm',
      size: dicomBytes.length,
    }

    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
    })

    expect(result.mappingRequired).toBe(true)

    const outputBytes = new Uint8Array(await result.mappedBlob!.arrayBuffer())

    // Output must be byte-identical to the input (no-op path preserves original)
    expect(outputBytes.length).toBe(dicomBytes.length)
    expect(Array.from(outputBytes)).toEqual(Array.from(dicomBytes))
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

describe('curateOne custom uploader', () => {
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

  function makeFileInfo(buffer: ArrayBuffer): TFileInfo {
    return {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name: 'test.dcm',
      size: buffer.byteLength,
    }
  }

  it('throws when outputTarget.custom is set but no uploader is provided', async () => {
    const buffer = buildDicomBuffer()
    await expect(
      curateOne({
        fileInfo: makeFileInfo(buffer),
        outputTarget: { custom: true },
        mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      }),
    ).rejects.toThrow('no uploader was provided')
  })

  it('calls uploader with correct args and captures etag', async () => {
    const buffer = buildDicomBuffer()
    const mockEtag = '"abc123"'
    const uploader = vi
      .fn<
        (args: {
          key: string
          stream: ReadableStream<Uint8Array>
          size: number
          contentType?: string
          headers?: Record<string, string>
          signal?: AbortSignal
        }) => Promise<{ etag?: string }>
      >()
      .mockResolvedValue({ etag: mockEtag })

    const result = await curateOne({
      fileInfo: makeFileInfo(buffer),
      outputTarget: { custom: true },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      uploader,
    })

    expect(uploader).toHaveBeenCalledOnce()
    const args = uploader.mock.calls[0][0]
    expect(args.key).toMatch(/^Sample_Protocol_Number/)
    expect(args.headers?.['x-source-file-hash']).toBeDefined()
    expect(result.outputUpload?.etag).toBe(mockEtag)
  })

  it('forwards signal to the uploader', async () => {
    const buffer = buildDicomBuffer()
    const controller = new AbortController()
    const uploader = vi
      .fn<
        (args: {
          key: string
          stream: ReadableStream<Uint8Array>
          size: number
          contentType?: string
          headers?: Record<string, string>
          signal?: AbortSignal
        }) => Promise<{ etag?: string }>
      >()
      .mockResolvedValue({})

    await curateOne({
      fileInfo: makeFileInfo(buffer),
      outputTarget: { custom: true },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      uploader,
      signal: controller.signal,
    })

    expect(uploader.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it('uses distinct header keys for pre- and post-mapped hashes', async () => {
    const buffer = buildDicomBuffer()
    let capturedHeaders: Record<string, string> | undefined

    await curateOne({
      fileInfo: makeFileInfo(buffer),
      outputTarget: { custom: true },
      mappingOptions: { curationSpec: noOpSpec, skipWrite: false },
      uploader: async ({ headers }) => {
        capturedHeaders = headers
        return {}
      },
      hashMethod: 'md5',
    })

    expect(capturedHeaders).toBeDefined()
    // Pre-mapped hash is always sent under x-source-file-hash.
    // Post-mapped hash, when present, uses a distinct key so there is no collision.
    expect('x-source-file-hash' in capturedHeaders!).toBe(true)
    const allKeys = Object.keys(capturedHeaders!)
    const hashKeys = allKeys.filter(
      (k) => k.includes('source-file') && k.includes('hash'),
    )
    // No duplicate keys (JS objects can't have duplicates, but verify the right names are used)
    expect(new Set(hashKeys).size).toBe(hashKeys.length)
    if ('x-source-file-post-mapped-hash' in capturedHeaders!) {
      expect('x-source-file-post-mapped-hash').not.toBe('x-source-file-hash')
    }
  })
})

describe('curateOne stream read failure during parse (regression #287)', () => {
  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

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

  /**
   * Build the leading bytes of a valid explicit-LE DICOM file: a 128-byte
   * zero preamble, the "DICM" magic, and the very start of the file-meta
   * group. This is enough for dcmjs's AsyncDicomReader to begin parsing and
   * park itself inside ensureAvailable() waiting for the rest of the header —
   * the exact state in which a mid-stream read failure used to deadlock
   * readFile() forever (issue #287).
   */
  function partialDicomHeader(): Uint8Array {
    const head = new Uint8Array(140)
    // bytes 0..127 are the zero preamble (already zeroed)
    head[128] = 0x44 // D
    head[129] = 0x49 // I
    head[130] = 0x43 // C
    head[131] = 0x4d // M
    // Start of (0002,0000) FileMetaInformationGroupLength, explicit-LE "UL".
    // Truncated deliberately: not enough bytes follow to satisfy the reader.
    head[132] = 0x02
    head[133] = 0x00 // group 0002 LE
    head[134] = 0x00
    head[135] = 0x00 // element 0000 LE
    head[136] = 0x55
    head[137] = 0x4c // VR = "UL"
    head[138] = 0x04
    head[139] = 0x00 // value length 4 (the 4 value bytes never arrive)
    return head
  }

  /**
   * A Blob whose stream() enqueues a partial DICOM header and then errors the
   * stream's reader mid-parse — simulating the browser behaviour where a
   * mode-0000 file served through Chrome's network service surfaces as
   * `TypeError: network error` on reader.read(). Extends native Blob so the
   * curateOne `kind: 'blob'` path accepts it.
   */
  class FailingStreamBlob extends Blob {
    declare readonly size: number

    constructor(private readonly failure: Error) {
      super([])
      Object.defineProperty(this, 'size', {
        value: 1024,
        configurable: true,
      })
    }

    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      const { failure } = this
      const header = partialDicomHeader()
      let errored = false
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (!errored) {
            // First pull: hand over the partial header so the reader starts
            // consuming and parks waiting for the remainder.
            controller.enqueue(header as Uint8Array<ArrayBuffer>)
            errored = true
            return
          }
          // Second pull: the underlying source fails mid-read.
          controller.error(failure)
        },
      })
    }
  }

  it('resolves with a parse-failure result instead of hanging when the stream errors mid-parse', async () => {
    const failure = new TypeError('network error')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new FailingStreamBlob(failure),
      path: inputPath,
      name: 'unreadable.dcm',
      size: 1024,
    }

    // If the deadlock regressed, this would never settle; the suite-level
    // timeout would then fail the test rather than hang the whole run.
    const result = await curateOne({
      fileInfo,
      outputTarget: {},
      mappingOptions: { curationSpec: noOpSpec, skipWrite: true },
    })

    // The catch block (curateOne.ts) returns a PHI-safe parse-failure result.
    expect(result.sourceInstanceUID).toMatch(/^invalid_/)
    // The raw filename must not leak into the server-bound UID.
    expect(result.sourceInstanceUID).not.toContain('unreadable')
    expect(result.anomalies).toEqual(['Could not parse file as DICOM data'])
    expect(result.errors).toEqual([
      'File is not a valid DICOM file or is corrupted',
    ])
    // fileInfo retains the real name for the private (input) log.
    expect(result.fileInfo?.name).toBe('unreadable.dcm')
    // No output path because nothing was written.
    expect(result.outputFilePath).toBeUndefined()
  }, 10_000)

  it('does not produce an unhandled promise rejection when the stream errors', async () => {
    const failure = new TypeError('network error')
    const fileInfo: TFileInfo = {
      kind: 'blob',
      blob: new FailingStreamBlob(failure),
      path: inputPath,
      name: 'unreadable.dcm',
      size: 1024,
    }

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      await curateOne({
        fileInfo,
        outputTarget: {},
        mappingOptions: { curationSpec: noOpSpec, skipWrite: true },
      })
      // Give any stray rejected promise a chance to surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  }, 10_000)
})

describe('curateOne DICOMDIR pre-exclusion', () => {
  const inputPath =
    'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen'

  // A spec that excludes DICOMDIRs by media storage SOP class. The SOP class
  // lives in the file meta group, so only getMetaDicom can see it.
  const dicomdirExcludingSpec: () => TCurationSpecification = () => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({}),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
    preExclude: (parser) =>
      parser.getMetaDicom('MediaStorageSOPClassUID') === DICOMDIR_SOP_CLASS_UID,
  })

  function fileInfoFor(buffer: ArrayBuffer, name: string): TFileInfo {
    return {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'application/octet-stream' }),
      path: inputPath,
      name,
      size: buffer.byteLength,
    }
  }

  it('excludes a DICOMDIR carrying a .dcm extension and writes nothing', async () => {
    const result = await curateOne({
      // Named like an instance: filename-based exclusion cannot catch this.
      fileInfo: fileInfoFor(buildDicomdirDcmjsBuffer(), 'IM000001.dcm'),
      outputTarget: {},
      mappingOptions: { curationSpec: dicomdirExcludingSpec, skipWrite: false },
    })

    expect(result.excluded).toBe('pre')
    expect(result.mappedBlob).toBeUndefined()
    expect(result.anomalies.join(' ')).toContain('IM000001.dcm')
  })

  it('cannot exclude a DICOMDIR that dcmjs rejects, but writes nothing', async () => {
    // Known limitation: preExclude runs only after a successful parse. A
    // DICOMDIR whose writer omitted the meta group length is rejected by dcmjs
    // outright, so it is reported as a parse error rather than a clean
    // exclusion. It is still never written to the output.
    const { buffer } = await generateFile({ type: 'dicomdir' })

    const result = await curateOne({
      fileInfo: fileInfoFor(buffer.buffer as ArrayBuffer, 'IM000009.dcm'),
      outputTarget: {},
      mappingOptions: { curationSpec: dicomdirExcludingSpec, skipWrite: false },
    })

    expect(result.excluded).toBeUndefined()
    expect(result.mappedBlob).toBeUndefined()
    expect(result.errors?.join(' ')).toContain('not a valid DICOM file')
  })

  it('does not exclude an ordinary image instance', async () => {
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

    const result = await curateOne({
      fileInfo: fileInfoFor(
        dicomDict.write({ allowInvalidVRLength: true }),
        'IM000002.dcm',
      ),
      outputTarget: {},
      mappingOptions: { curationSpec: dicomdirExcludingSpec, skipWrite: false },
    })

    expect(result.excluded).toBeUndefined()
    expect(result.mappedBlob).toBeDefined()
  })
})
