import {
  type DicomTagOverrides,
  generateFile,
  type TransferSyntax,
} from 'dicom-synth'

/**
 * Synthetic images carrying an Icon Image Sequence (0088,0200) whose item
 * holds a nested Pixel Data (7FE0,0010), as PS3.3 C.7.6.1.1.6 allows (#331).
 *
 * Written by dicom-synth (through dcmjs), so the sequence and item have
 * undefined lengths, the layout vendor files use. The icon is a 4x4 8-bit
 * MONOCHROME2 image filled with ICON_PIXEL_BYTE; the top-level Pixel Data is
 * filled with TOP_PIXEL_BYTE, so either can be located in an output.
 */
export const ICON_PIXEL_BYTE = 0x07
export const ICON_PIXEL_LENGTH = 16
export const TOP_PIXEL_BYTE = 0xaa
export const TOP_PIXEL_LENGTH = 24

const PIXEL_DATA_TAG_LE = Buffer.from([0xe0, 0x7f, 0x10, 0x00])

export type IconImageFixture = {
  buffer: Buffer
  /** Byte offset of the top-level (7FE0,0010) tag. */
  topLevelPixelDataOffset: number
}

export async function buildIconImageFile(options: {
  pixelVr: 'OB' | 'OW'
  transferSyntax?: TransferSyntax
  /** Top-level NumberOfFrames (0028,0008); omitted when undefined. */
  numberOfFrames?: string
}): Promise<IconImageFixture> {
  const us = (value: number) => ({ vr: 'US', value })
  const tags: DicomTagOverrides = {
    PixelData: new Uint8Array(TOP_PIXEL_LENGTH).fill(TOP_PIXEL_BYTE).buffer,
    ...(options.numberOfFrames && { NumberOfFrames: options.numberOfFrames }),
    '00880200': {
      vr: 'SQ',
      value: [
        {
          '00280002': us(1),
          '00280004': { vr: 'CS', value: 'MONOCHROME2' },
          '00280010': us(4),
          '00280011': us(4),
          '00280100': us(8),
          '00280101': us(8),
          '00280102': us(7),
          '00280103': us(0),
          '7FE00010': {
            vr: options.pixelVr,
            value: [
              new Uint8Array(ICON_PIXEL_LENGTH).fill(ICON_PIXEL_BYTE).buffer,
            ],
          },
        },
      ],
    },
  }
  const { buffer } = await generateFile({
    type: 'valid-image',
    modality: 'MR',
    ...(options.transferSyntax && { transferSyntax: options.transferSyntax }),
    tags,
  })
  // The top-level Pixel Data is the last element and its value contains no
  // tag-like bytes, so the last tag match is the top-level one.
  return {
    buffer,
    topLevelPixelDataOffset: buffer.lastIndexOf(PIXEL_DATA_TAG_LE),
  }
}
