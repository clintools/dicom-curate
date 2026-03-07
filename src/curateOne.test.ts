import * as dcmjs from 'dcmjs'
import { jest } from '@jest/globals'
import { curateOne } from './curateOne'
import type { TFileInfo, TMappingOptions } from './types'

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

    const readFileSpy = jest.spyOn(dcmjs.data.DicomMessage, 'readFile')

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
