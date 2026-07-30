import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupTestDicomDir,
  createTestDicomDir,
} from '../testutils/dicomFixtures'
import {
  createMappingHandler,
  type MappingRequest,
  safeSerializeError,
} from './applyMappingsCore'
import { extractCsvMappings, type Row, type TMappedValues } from './csvMapping'
import { serializeMappingOptions } from './serializeMappingOptions'
import type { TFileInfo, TSerializedMappingOptions } from './types'

// PatientID written by createTestDicomDir (tag 00100020).
const FIXTURE_PATIENT_ID = 'TEST-PATIENT-001'

const testCsvMapping: TMappedValues = {
  centerSubjectId: {
    value: (p) => p.getDicom('PatientID'),
    lookup: (row: Row) => String(row.oldId),
    replace: (row: Row) => String(row.newId),
  },
}

function csvMappingOptions(csv: string): TSerializedMappingOptions {
  return serializeMappingOptions({
    curationSpec: () => ({
      version: '3.0',
      inputPathPattern: 'study/subject',
      hostProps: {},
      dicomPS315EOptions: 'Off',
      modifyDicomHeader: (parser) => ({
        PatientID: String(parser.getMapping!('centerSubjectId')),
      }),
      additionalData: {
        mapping: {
          centerSubjectId: {
            value: (p) => p.getDicom('PatientID'),
            lookup: (row: Row) => String(row.oldId),
            replace: (row: Row) => String(row.newId),
          },
        },
        type: 'load',
        collect: {},
      },
      outputFilePathComponents: () => ['out', 'subject', 'mapped.dcm'],
      errors: () => [],
    }),
    columnMappings: extractCsvMappings(csv, testCsvMapping),
    skipWrite: true,
  })
}

function noneOptions(skipWrite: boolean): TSerializedMappingOptions {
  return serializeMappingOptions({
    curationSpec: () => ({
      version: '3.0',
      inputPathPattern: 'study/subject',
      hostProps: {},
      dicomPS315EOptions: 'Off',
      modifyDicomHeader: () => ({}),
      outputFilePathComponents: () => ['study', 'subject', 'file.dcm'],
      errors: () => [],
    }),
    skipWrite,
  })
}

type Emitted = Record<string, any>

/**
 * Drive one request through a fresh handler and collect every emitted message.
 * Lookup requests are answered inline (mirroring the main thread) so the apply
 * flow can complete.
 */
function runHandler(
  request: unknown,
  options?: {
    onLookup?: (outputPath: string) => { postMappedHash?: string } | undefined
    onUpload?: (message: Emitted) => { etag?: string }
  },
): Promise<Emitted[]> {
  return new Promise((resolve) => {
    const emitted: Emitted[] = []
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const { handleMessage } = createMappingHandler((msg) => {
      const message = msg as Emitted
      emitted.push(message)

      if (message.response === 'lookup') {
        const result = options?.onLookup?.(message.outputPath)
        handleMessage({
          data: {
            response: 'lookupResult',
            postMappedHash: result?.postMappedHash,
          },
        } as MessageEvent)
        return
      }

      if (message.response === 'upload') {
        const result = options?.onUpload?.(message) ?? {}
        handleMessage({
          data: { response: 'uploadResult', etag: result.etag },
        } as MessageEvent)
        return
      }

      if (message.response === 'finished' || message.response === 'error') {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => resolve(emitted), 0)
      }
    })

    handleMessage({ data: request } as MessageEvent)
  })
}

function pathFileInfo(fullPath: string): TFileInfo {
  return {
    kind: 'path',
    fullPath,
    path: 'study/subject',
    name: 'file.dcm',
    size: statSync(fullPath).size,
  }
}

describe('safeSerializeError', () => {
  it('formats Error instances as "name: message"', () => {
    expect(safeSerializeError(new TypeError('bad thing'))).toBe(
      'TypeError: bad thing',
    )
  })

  it('stringifies non-Error values', () => {
    expect(safeSerializeError('plain string')).toBe('plain string')
    expect(safeSerializeError(42)).toBe('42')
  })

  it('falls back when a value cannot be stringified', () => {
    // Object.create(null) has no prototype, so String() throws
    // "Cannot convert object to primitive value".
    expect(safeSerializeError(Object.create(null))).toBe(
      'Unknown error (could not serialize)',
    )
  })
})

describe('createMappingHandler', () => {
  let baseDir: string
  let dcmPath: string
  const dirs: string[] = []

  beforeEach(() => {
    baseDir = createTestDicomDir(1, { subdirName: 'S' })
    dcmPath = join(baseDir, 'S', 'test_0000.dcm')
  })

  afterEach(() => {
    cleanupTestDicomDir(baseDir)
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('applies a no-op spec and reports finished', async () => {
    const emitted = await runHandler({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath),
      serializedMappingOptions: noneOptions(true),
    } satisfies MappingRequest)

    const finished = emitted.find((m) => m.response === 'finished')
    expect(finished).toBeDefined()
    expect(finished!.mapResults.errors).toEqual([])
  })

  it('applies a CSV mapping and rewrites PatientID', async () => {
    const emitted = await runHandler({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath),
      serializedMappingOptions: csvMappingOptions(
        `oldId,newId\n${FIXTURE_PATIENT_ID},NEW-ID\n`,
      ),
    } satisfies MappingRequest)

    const finished = emitted.find((m) => m.response === 'finished')
    expect(finished).toBeDefined()
    expect(finished!.mapResults.mappings?.PatientID?.[3]).toBe('NEW-ID')
  })

  it('emits an error response when the mapping fails', async () => {
    const emitted = await runHandler({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath),
      serializedMappingOptions: csvMappingOptions('oldId,newId\nOTHER,X\n'),
    } satisfies MappingRequest)

    const error = emitted.find((m) => m.response === 'error')
    expect(error).toBeDefined()
    expect(String(error!.error)).toContain('No row for')
    // fileInfo travels with the error so the main thread can recover the slot.
    expect(error!.fileInfo?.name).toBe('file.dcm')
  })

  it('round-trips a lookup with the main thread and skips re-mapping', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mapcore-out-'))
    dirs.push(outDir)

    const first = await runHandler({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath),
      outputTarget: { directory: outDir },
      serializedMappingOptions: noneOptions(false),
      hashMethod: 'md5',
    } satisfies MappingRequest)
    const firstFinished = first.find((m) => m.response === 'finished')
    const knownHash = firstFinished?.mapResults.fileInfo?.postMappedHash
    expect(knownHash).toBeDefined()

    const second = await runHandler(
      {
        request: 'apply',
        fileInfo: pathFileInfo(dcmPath),
        outputTarget: { directory: outDir },
        serializedMappingOptions: noneOptions(false),
        hashMethod: 'md5',
      } satisfies MappingRequest,
      { onLookup: () => ({ postMappedHash: knownHash }) },
    )

    expect(second.some((m) => m.response === 'lookup')).toBe(true)
    const finished = second.find((m) => m.response === 'finished')
    expect(finished!.mapResults.mappingRequired).toBe(false)
  })

  it('proxies a custom upload through the main thread', async () => {
    const emitted = await runHandler(
      {
        request: 'apply',
        fileInfo: pathFileInfo(dcmPath),
        outputTarget: { custom: true },
        serializedMappingOptions: noneOptions(false),
      } satisfies MappingRequest,
      { onUpload: () => ({ etag: 'etag-123' }) },
    )

    const upload = emitted.find((m) => m.response === 'upload')
    expect(upload).toBeDefined()
    // The blob body is handed off as a transferable stream.
    expect(upload!.stream).toBeInstanceOf(ReadableStream)

    const finished = emitted.find((m) => m.response === 'finished')
    expect(finished!.mapResults.outputUpload?.etag).toBe('etag-123')
  })

  it('logs and ignores unknown request types', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const emitted: unknown[] = []
    const { handleMessage } = createMappingHandler((msg) => emitted.push(msg))

    handleMessage({ data: { request: 'no-such-op' } } as MessageEvent)

    expect(emitted).toEqual([])
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown request'))
    spy.mockRestore()
  })

  it('ignores lookup/upload responses that have no pending round-trip', () => {
    const emitted: unknown[] = []
    const { handleMessage } = createMappingHandler((msg) => emitted.push(msg))

    // None of these should throw or emit — there is nothing in flight.
    handleMessage({
      data: { response: 'lookupResult', postMappedHash: 'x' },
    } as MessageEvent)
    handleMessage({
      data: { response: 'uploadResult', etag: 'e' },
    } as MessageEvent)
    handleMessage({
      data: { response: 'uploadError', error: 'boom' },
    } as MessageEvent)

    expect(emitted).toEqual([])
  })

  it('uses the minimal fallback response when emitting an error itself throws', async () => {
    let throwOnNextError = true
    const emitted: Emitted[] = []

    await new Promise<void>((resolve) => {
      const { handleMessage } = createMappingHandler((msg) => {
        const message = msg as Emitted
        if (message.response === 'error' && throwOnNextError) {
          throwOnNextError = false
          // Simulate postMessage/DataCloneError on the first attempt.
          throw new Error('clone failed')
        }
        emitted.push(message)
        if (message.response === 'error') {
          setTimeout(resolve, 0)
        }
      })

      handleMessage({
        data: {
          request: 'apply',
          fileInfo: pathFileInfo(dcmPath),
          serializedMappingOptions: csvMappingOptions('oldId,newId\nNONE,X\n'),
        },
      } as MessageEvent)
    })

    const fallback = emitted.find((m) => m.response === 'error')
    expect(fallback).toBeDefined()
    expect(fallback!.error).toBe('Worker error (failed to serialize)')
    expect(fallback!.fileInfo.name).toBe('file.dcm')
  })
})
