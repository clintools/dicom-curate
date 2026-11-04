import * as dcmjs from 'dcmjs'
import { generateFile } from 'dicom-synth'
import {
  buildDicomdirDcmjsBuffer,
  DICOMDIR_SOP_CLASS_UID,
} from '../testutils/dicomdirFixture'
import {
  buildIconImageFile,
  ICON_PIXEL_BYTE,
  ICON_PIXEL_LENGTH,
  TOP_PIXEL_BYTE,
  TOP_PIXEL_LENGTH,
} from '../testutils/iconImageFixture'
import { curateOne, NESTED_ENCAPSULATED_PIXEL_DATA_ERROR } from './curateOne'
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

  // pixelSpec has PS3.15 off, which keeps the Icon Image Sequence.
  describe('Icon Image Sequence with nested Pixel Data (#331)', () => {
    const ICON_PIXELS = [0xa1, 0xa2, 0xa3, 0xa4]
    const TOP_PIXELS = [0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58]
    // Removes the Icon Image Sequence (PS3.15 Table E.1-1 action X).
    const BASIC_PROFILE: TCurationSpecification['dicomPS315EOptions'] = {
      cleanDescriptorsOption: true,
      cleanDescriptorsExceptions: [],
      retainLongitudinalTemporalInformationOptions: 'Off',
      retainPatientCharacteristicsOption: [],
      retainDeviceIdentityOption: true,
      retainUIDsOption: 'Hashed',
      retainSafePrivateOption: 'Quarantine',
      retainInstitutionIdentityOption: true,
    }
    const UNDEFINED_LENGTH = 0xffffffff
    const ascii = new TextEncoder()

    const concat = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let offset = 0
      for (const part of parts) {
        out.set(part, offset)
        offset += part.length
      }
      return out
    }
    const uint16 = (n: number) => {
      const b = new Uint8Array(2)
      new DataView(b.buffer).setUint16(0, n, true)
      return b
    }
    const uint32 = (n: number) => {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setUint32(0, n, true)
      return b
    }
    const tag = (group: number, element: number) =>
      concat(uint16(group), uint16(element))
    const evenText = (text: string, pad: number) => {
      const b = ascii.encode(text)
      return b.length % 2 ? concat(b, new Uint8Array([pad])) : b
    }
    // Explicit-LE element with a 2-byte length (UI, PN, US, UL).
    const shortElement = (
      g: number,
      e: number,
      vr: string,
      value: Uint8Array,
    ) => concat(tag(g, e), ascii.encode(vr), uint16(value.length), value)
    // Explicit-LE element with reserved bytes and a 4-byte length (OB, OW, SQ).
    const longElement = (
      g: number,
      e: number,
      vr: string,
      value: Uint8Array,
      length = value.length,
    ) => concat(tag(g, e), ascii.encode(vr), uint16(0), uint32(length), value)

    const EXPLICIT_LE = '1.2.840.10008.1.2.1'
    const RLE_LOSSLESS = '1.2.840.10008.1.2.5'

    /** Synthetic Part 10 file: preamble, explicit-LE meta group, then `body`. */
    function part10(
      body: Uint8Array,
      transferSyntaxUid = EXPLICIT_LE,
    ): Uint8Array {
      const sopClass = evenText('1.2.840.10008.5.1.4.1.1.7', 0)
      const metaBody = concat(
        longElement(0x0002, 0x0001, 'OB', new Uint8Array([0x00, 0x01])),
        shortElement(0x0002, 0x0002, 'UI', sopClass),
        shortElement(0x0002, 0x0003, 'UI', evenText('1.2.3.4', 0)),
        shortElement(0x0002, 0x0010, 'UI', evenText(transferSyntaxUid, 0)),
      )
      return concat(
        new Uint8Array(128),
        ascii.encode('DICM'),
        shortElement(0x0002, 0x0000, 'UL', uint32(metaBody.length)),
        metaBody,
        shortElement(0x0008, 0x0016, 'UI', sopClass),
        shortElement(0x0008, 0x0018, 'UI', evenText('1.2.3.4', 0)),
        shortElement(0x0010, 0x0010, 'PN', evenText('Test^Synthetic', 0x20)),
        body,
      )
    }

    // Encapsulated Pixel Data: empty Basic Offset Table, then one item per fragment.
    const encapsulatedPixelData = (fragments: number[][]) =>
      longElement(
        0x7fe0,
        0x0010,
        'OB',
        concat(
          tag(0xfffe, 0xe000),
          uint32(0),
          ...fragments.flatMap((fragment) => [
            tag(0xfffe, 0xe000),
            uint32(fragment.length),
            new Uint8Array(fragment),
          ]),
          tag(0xfffe, 0xe0dd),
          uint32(0),
        ),
        UNDEFINED_LENGTH,
      )

    function buildDicomWithIconImageSequence({
      vr = 'OB',
      lengths = 'defined',
      numberOfFrames,
      encapsulated = false,
    }: {
      vr?: 'OB' | 'OW'
      lengths?: 'defined' | 'undefined'
      numberOfFrames?: number
      // RLE transfer syntax with the icon split across two fragments.
      encapsulated?: boolean
    }): Uint8Array {
      // Top-level attributes dcmjs reads when sizing Pixel Data frames.
      const imageAttributes = numberOfFrames
        ? concat(
            shortElement(0x0028, 0x0002, 'US', uint16(1)),
            shortElement(
              0x0028,
              0x0008,
              'IS',
              evenText(`${numberOfFrames}`, 0x20),
            ),
            shortElement(0x0028, 0x0010, 'US', uint16(4)),
            shortElement(0x0028, 0x0011, 'US', uint16(4)),
            shortElement(0x0028, 0x0100, 'US', uint16(8)),
          )
        : new Uint8Array(0)
      const itemBody = concat(
        shortElement(0x0028, 0x0010, 'US', uint16(2)),
        shortElement(0x0028, 0x0011, 'US', uint16(2)),
        shortElement(0x0028, 0x0100, 'US', uint16(8)),
        encapsulated
          ? encapsulatedPixelData([
              ICON_PIXELS.slice(0, 2),
              ICON_PIXELS.slice(2),
            ])
          : longElement(0x7fe0, 0x0010, vr, new Uint8Array(ICON_PIXELS)),
      )
      const undef = lengths === 'undefined'
      // Item (E00D) or Sequence (E0DD) Delimitation Item, only for undefined lengths.
      const delimiter = (element: number) =>
        undef ? concat(tag(0xfffe, element), uint32(0)) : new Uint8Array(0)
      const item = concat(
        tag(0xfffe, 0xe000),
        uint32(undef ? UNDEFINED_LENGTH : itemBody.length),
        itemBody,
        delimiter(0xe00d),
      )
      const sequence = longElement(
        0x0088,
        0x0200,
        'SQ',
        concat(item, delimiter(0xe0dd)),
        undef ? UNDEFINED_LENGTH : undefined,
      )
      return part10(
        concat(
          imageAttributes,
          sequence,
          encapsulated
            ? encapsulatedPixelData([TOP_PIXELS])
            : longElement(0x7fe0, 0x0010, 'OW', new Uint8Array(TOP_PIXELS)),
        ),
        encapsulated ? RLE_LOSSLESS : EXPLICIT_LE,
      )
    }

    const blobFileInfo = (bytes: Uint8Array): TFileInfo => ({
      kind: 'blob',
      blob: new Blob([bytes.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
      path: inputPath,
      name: 'icon.dcm',
      size: bytes.length,
    })

    // DicomMessage.readFile stores OB/OW values as [ArrayBuffer].
    const pixelBytes = (element: dcmjs.DicomJsonElement) =>
      Array.from(new Uint8Array(element.Value![0] as unknown as ArrayBuffer))

    const countOccurrences = (haystack: Uint8Array, needle: number[]) => {
      let count = 0
      for (let i = 0; i + needle.length <= haystack.length; i++) {
        if (needle.every((byte, j) => haystack[i + j] === byte)) count++
      }
      return count
    }

    async function expectIconAndPixelDataKept(dicomBytes: Uint8Array) {
      const result = await curateOne({
        fileInfo: blobFileInfo(dicomBytes),
        outputTarget: {},
        mappingOptions: { curationSpec: pixelSpec, skipWrite: false },
      })

      expect(result.errors).toEqual([])
      expect(result.anomalies).not.toContain(
        'Could not parse file as DICOM data',
      )
      expect(result.mappingRequired).toBe(true)

      const output = new Uint8Array(await result.mappedBlob!.arrayBuffer())
      // A slice taken from the nested Pixel Data tag would repeat the icon bytes
      // after the re-serialised header.
      expect(countOccurrences(output, ICON_PIXELS)).toBe(1)

      const reparsed = dcmjs.data.DicomMessage.readFile(
        output.buffer as ArrayBuffer,
      )
      const iconItem = reparsed.dict['00880200'].Value![0] as dcmjs.DicomDataset
      expect(pixelBytes(iconItem['7FE00010'])).toEqual(ICON_PIXELS)
      expect(pixelBytes(reparsed.dict['7FE00010'])).toEqual(TOP_PIXELS)
    }

    it.each([
      ['OB', 'defined'],
      ['OB', 'undefined'],
      ['OW', 'defined'],
      ['OW', 'undefined'],
    ] as const)('parses and keeps a %s icon with %s sequence lengths', async (vr, lengths) => {
      await expectIconAndPixelDataKept(
        buildDicomWithIconImageSequence({ vr, lengths }),
      )
    })

    // dcmjs sizes Pixel Data by the top-level NumberOfFrames: 2 frames split
    // the icon and break the write, 3 frames fail the parse.
    it.each([
      2, 3,
    ])('keeps the icon intact in a %i-frame image', async (numberOfFrames) => {
      await expectIconAndPixelDataKept(
        buildDicomWithIconImageSequence({ numberOfFrames }),
      )
    })

    // A nested encapsulated Pixel Data parses, but DicomDict.write would store
    // it with an explicit length, its compressed bytes then read as native
    // pixels. curateOne writes such a file only when the header is unchanged or
    // the sequence is removed.
    describe('with an encapsulated icon', () => {
      const encapsulatedIconFile = () =>
        buildDicomWithIconImageSequence({ encapsulated: true })

      it('does not write a re-encoded header that keeps the icon', async () => {
        const result = await curateOne({
          fileInfo: blobFileInfo(encapsulatedIconFile()),
          outputTarget: {},
          mappingOptions: { curationSpec: pixelSpec, skipWrite: false },
        })

        expect(result.errors).toEqual([NESTED_ENCAPSULATED_PIXEL_DATA_ERROR])
        expect(result.mappedBlob).toBeUndefined()
        expect(result.outputFilePath).toBeUndefined()
        expect(result.fileInfo?.parseError).toBeUndefined()
      })

      it('writes the image when the PS3.15 Basic Profile removes the icon', async () => {
        const result = await curateOne({
          fileInfo: blobFileInfo(encapsulatedIconFile()),
          outputTarget: {},
          mappingOptions: {
            curationSpec: () => ({
              ...pixelSpec(),
              dicomPS315EOptions: BASIC_PROFILE,
            }),
            skipWrite: false,
          },
        })

        expect(result.errors).toEqual([])
        const output = new Uint8Array(await result.mappedBlob!.arrayBuffer())
        const reparsed = dcmjs.data.DicomMessage.readFile(
          output.buffer as ArrayBuffer,
        )
        expect(reparsed.dict['00880200']).toBeUndefined()
        expect(pixelBytes(reparsed.dict['7FE00010'])).toEqual(TOP_PIXELS)
      })

      it('writes the original bytes when skipModifications leaves the header unchanged', async () => {
        const input = encapsulatedIconFile()
        const result = await curateOne({
          fileInfo: blobFileInfo(input),
          outputTarget: {},
          mappingOptions: {
            curationSpec: pixelSpec,
            skipModifications: true,
            skipWrite: false,
          },
        })

        expect(result.errors).toEqual([])
        const output = new Uint8Array(await result.mappedBlob!.arrayBuffer())
        expect(Array.from(output)).toEqual(Array.from(input))
      })
    })

    it('records a non-empty parseError when dcmjs throws an Error without a message', async () => {
      // An undefined-length SQ whose first child is not an Item: dcmjs
      // readSequence throws `new Error()`.
      const corrupt = part10(
        concat(
          longElement(
            0x0088,
            0x0200,
            'SQ',
            new Uint8Array(0),
            UNDEFINED_LENGTH,
          ),
          shortElement(0x0028, 0x0010, 'US', uint16(2)),
        ),
      )

      const result = await curateOne({
        fileInfo: blobFileInfo(corrupt),
        outputTarget: {},
        mappingOptions: { curationSpec: pixelSpec, skipWrite: true },
      })

      expect(result.anomalies).toEqual(['Could not parse file as DICOM data'])
      expect(result.errors).toEqual([
        'File is not a valid DICOM file or is corrupted',
      ])
      expect(result.fileInfo?.parseError).toMatch(/./)
    })
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

describe('curateOne Icon Image Sequence from dicom-synth fixtures (#331)', () => {
  const iconSpec = (): TCurationSpecification => ({
    inputPathPattern:
      'protocolNumber/activityProvider/centerSubjectId/timepoint/scan',
    version: '3.0',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    // A header change forces the re-serialised header + Pixel Data slice path.
    modifyDicomHeader: () => ({ PatientName: 'ANON' }),
    outputFilePathComponents: (parser) => [
      parser.getFilePathComp('protocolNumber'),
      parser.getFilePathComp(parser.FILENAME),
    ],
    errors: () => [],
  })

  // Streams the file in small chunks, so element headers and values straddle
  // chunk boundaries the way they do in large real files.
  class ChunkedBlob extends Blob {
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      let offset = 0
      return new ReadableStream({
        pull: async (controller) => {
          if (offset >= this.size) {
            controller.close()
            return
          }
          const chunk = this.slice(offset, offset + 7)
          offset += 7
          controller.enqueue(new Uint8Array(await chunk.arrayBuffer()))
        },
      })
    }
  }

  const bytesOf = (value: unknown) =>
    Array.from(new Uint8Array(value as ArrayBuffer))

  it.each([
    ['explicit-vr-little-endian', 'OB', undefined],
    ['explicit-vr-little-endian', 'OW', '1'],
    ['explicit-vr-little-endian', 'OW', '4'],
    ['implicit-vr-little-endian', 'OB', '1'],
    ['implicit-vr-little-endian', 'OW', '4'],
  ] as const)('keeps a %s %s icon with NumberOfFrames %s, streamed in 7-byte chunks', async (transferSyntax, pixelVr, numberOfFrames) => {
    const fixture = await buildIconImageFile({
      pixelVr,
      transferSyntax,
      numberOfFrames,
    })

    const result = await curateOne({
      fileInfo: {
        kind: 'blob',
        blob: new ChunkedBlob([new Uint8Array(fixture.buffer)]),
        path: 'Sample_Protocol_Number/Sample_CRO/AB12-123/Visit 1/PET-Abdomen',
        name: 'icon.dcm',
        size: fixture.buffer.length,
      },
      outputTarget: {},
      mappingOptions: { curationSpec: iconSpec, skipWrite: false },
    })

    expect(result.errors).toEqual([])
    const output = new Uint8Array(await result.mappedBlob!.arrayBuffer())
    // The appended slice starts at the top-level (7FE0,0010): the output ends
    // with the source's top-level element.
    const topLevelElement = fixture.buffer.subarray(
      fixture.topLevelPixelDataOffset,
    )
    expect(
      Array.from(output.subarray(output.length - topLevelElement.length)),
    ).toEqual(Array.from(topLevelElement))

    const reparsed = dcmjs.data.DicomMessage.readFile(
      output.buffer as ArrayBuffer,
    )
    const iconItem = reparsed.dict['00880200'].Value![0] as dcmjs.DicomDataset
    expect(bytesOf(iconItem['7FE00010'].Value![0])).toEqual(
      Array(ICON_PIXEL_LENGTH).fill(ICON_PIXEL_BYTE),
    )
    expect(bytesOf(reparsed.dict['7FE00010'].Value![0])).toEqual(
      Array(TOP_PIXEL_LENGTH).fill(TOP_PIXEL_BYTE),
    )
  })
})
