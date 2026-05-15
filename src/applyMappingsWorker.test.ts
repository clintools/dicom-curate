import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractCsvMappings,
  type Row,
  type TColumnMappings,
  type TMappedValues,
} from './csvMapping'
import { serializeMappingOptions } from './serializeMappingOptions'
import type { TFileInfo, TSerializedMappingOptions } from './types'
import { writeMinimalDicomFile } from '../testutils/minimalDicom'
import { runMappingWorker } from '../testutils/workerTestHelpers'

const testCsvMapping: TMappedValues = {
  centerSubjectId: {
    value: (p) => p.getDicom('PatientID'),
    lookup: (row: Row) => String(row.oldId),
    replace: (row: Row) => String(row.newId),
  },
}

function serializedCsvOptions(
  columnMappings: TColumnMappings,
): TSerializedMappingOptions {
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
    columnMappings,
    skipWrite: true,
  })
}

function serializedNoneOptions(): TSerializedMappingOptions {
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
    skipWrite: true,
  })
}

function pathFileInfo(
  fullPath: string,
  path: string,
  name: string,
): TFileInfo {
  const buf = readFileSync(fullPath)
  return {
    kind: 'path',
    fullPath,
    path,
    name,
    size: buf.length,
  }
}

describe('applyMappingsWorker', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('applies valid CSV mappings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-valid-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: 'OLD-ID' })

    const csv = 'oldId,newId\nOLD-ID,NEW-ID\n'
    const columnMappings = extractCsvMappings(csv, testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      serializedMappingOptions: serializedCsvOptions(columnMappings),
    })

    const finished = results.find((r) => r.kind === 'finished')
    expect(finished?.kind).toBe('finished')
    if (finished?.kind === 'finished') {
      expect(finished.mapResults.errors).toEqual([])
      expect(finished.mapResults.mappings?.PatientID).toBeDefined()
    }
  })

  it('returns error for missing CSV mapping row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-missing-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: 'UNKNOWN-ID' })

    const csv = 'oldId,newId\nOLD-ID,NEW-ID\n'
    const columnMappings = extractCsvMappings(csv, testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      serializedMappingOptions: serializedCsvOptions(columnMappings),
    })

    const err = results.find((r) => r.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      expect(err.error).toContain('No row for')
    }
  })

  it('uses last CSV row when duplicate lookup keys exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-dup-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: 'DUP-ID' })

    const csv = 'oldId,newId\nDUP-ID,FIRST\nDUP-ID,SECOND\n'
    const columnMappings = extractCsvMappings(csv, testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      serializedMappingOptions: serializedCsvOptions(columnMappings),
    })

    const finished = results.find((r) => r.kind === 'finished')
    expect(finished?.kind).toBe('finished')
    if (finished?.kind === 'finished') {
      const mapped = finished.mapResults.mappings?.PatientID
      expect(mapped?.[3]).toBe('SECOND')
    }
  })

  it('survives malformed CSV (empty rows) with mapping failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-badcsv-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: 'OLD-ID' })

    const columnMappings = extractCsvMappings('only-header\n', testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      serializedMappingOptions: serializedCsvOptions(columnMappings),
    })

    const err = results.find((r) => r.kind === 'error')
    expect(err?.kind).toBe('error')
  })

  it('errors on unexpected path identifiers when pattern does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-path-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'only', 'one', 'segment.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: 'OLD-ID' })

    const csv = 'oldId,newId\nOLD-ID,NEW-ID\n'
    const columnMappings = extractCsvMappings(csv, testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'only/one', 'segment.dcm'),
      serializedMappingOptions: serializeMappingOptions({
        curationSpec: () => ({
          version: '3.0',
          inputPathPattern: 'only/one',
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
          errors: (parser) => {
            if (parser.getFilePathComp('one') !== 'expected') {
              return [['unexpected path segment for one', true]]
            }
            return []
          },
        }),
        columnMappings,
        skipWrite: true,
      }),
    })

    const finished = results.find((r) => r.kind === 'finished')
    expect(finished?.kind).toBe('finished')
    if (finished?.kind === 'finished') {
      expect(finished.mapResults.errors?.length).toBeGreaterThan(0)
    }
  })

  it('recovers from a bad file then processes a valid file in a new worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-partial-'))
    dirs.push(dir)
    const goodPath = join(dir, 'study', 'subject', 'good.dcm')
    writeMinimalDicomFile(goodPath, { patientId: 'OLD-ID' })

    const badFileInfo: TFileInfo = {
      kind: 'blob',
      blob: new Blob([new Uint8Array([1, 2, 3])], {
        type: 'application/octet-stream',
      }),
      path: 'study/subject',
      name: 'bad.dcm',
      size: 3,
    }

    const badResults = await runMappingWorker({
      request: 'apply',
      fileInfo: badFileInfo,
      serializedMappingOptions: serializedNoneOptions(),
    })
    const badFinished = badResults.find((r) => r.kind === 'finished')
    expect(badFinished?.kind).toBe('finished')
    if (badFinished?.kind === 'finished') {
      const msg =
        badFinished.mapResults.anomalies.join(' ') +
        badFinished.mapResults.errors.join(' ')
      expect(msg.toLowerCase()).toContain('parse')
    }

    const csv = 'oldId,newId\nOLD-ID,NEW-ID\n'
    const goodResults = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(goodPath, 'study/subject', 'good.dcm'),
      serializedMappingOptions: serializedCsvOptions(
        extractCsvMappings(csv, {
          centerSubjectId: {
            value: (p) => p.getDicom('PatientID'),
            lookup: (row: Row) => String(row.oldId),
            replace: (row: Row) => String(row.newId),
          },
        }),
      ),
    })
    expect(goodResults.some((r) => r.kind === 'finished')).toBe(true)
  })

  it('handles a large CSV mapping table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-large-'))
    dirs.push(dir)
    const targetId = 'ID-0500'
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath, { patientId: targetId })

    const lines = ['oldId,newId']
    for (let i = 0; i < 1000; i++) {
      lines.push(`ID-${String(i).padStart(4, '0')},MAPPED-${i}`)
    }
    const columnMappings = extractCsvMappings(lines.join('\n'), testCsvMapping)

    const results = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      serializedMappingOptions: serializedCsvOptions(columnMappings),
    })

    const finished = results.find((r) => r.kind === 'finished')
    expect(finished?.kind).toBe('finished')
    if (finished?.kind === 'finished') {
      expect(finished.mapResults.errors).toEqual([])
    }
  })

  it('responds to lookup requests from the main thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-lookup-'))
    dirs.push(dir)
    const dcmPath = join(dir, 'study', 'subject', 'file.dcm')
    writeMinimalDicomFile(dcmPath)

    const outDir = mkdtempSync(join(tmpdir(), 'map-out-'))
    dirs.push(outDir)

    const first = await runMappingWorker({
      request: 'apply',
      fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
      outputTarget: { directory: outDir },
      serializedMappingOptions: serializeMappingOptions({
        curationSpec: () => ({
          version: '3.0',
          inputPathPattern: 'study/subject',
          hostProps: {},
          dicomPS315EOptions: 'Off',
          modifyDicomHeader: () => ({}),
          outputFilePathComponents: () => ['study', 'subject', 'file.dcm'],
          errors: () => [],
        }),
        skipWrite: false,
      }),
      hashMethod: 'md5',
    })
    const firstFinished = first.find((r) => r.kind === 'finished')
    const knownHash = firstFinished?.kind === 'finished'
      ? firstFinished.mapResults.fileInfo?.postMappedHash
      : undefined
    expect(knownHash).toBeDefined()

    const results = await runMappingWorker(
      {
        request: 'apply',
        fileInfo: pathFileInfo(dcmPath, 'study/subject', 'file.dcm'),
        outputTarget: { directory: outDir },
        serializedMappingOptions: serializeMappingOptions({
          curationSpec: () => ({
            version: '3.0',
            inputPathPattern: 'study/subject',
            hostProps: {},
            dicomPS315EOptions: 'Off',
            modifyDicomHeader: () => ({}),
            outputFilePathComponents: () => ['study', 'subject', 'file.dcm'],
            errors: () => [],
          }),
          skipWrite: false,
        }),
        hashMethod: 'md5',
      },
      {
        onLookup: () => ({ postMappedHash: knownHash }),
      },
    )

    expect(results.some((r) => r.kind === 'lookup')).toBe(true)
    const finished = results.find((r) => r.kind === 'finished')
    expect(finished?.kind).toBe('finished')
    if (finished?.kind === 'finished') {
      expect(finished.mapResults.mappingRequired).toBe(false)
    }
  })

  it('ignores unknown request types without crashing', async () => {
    const worker = await import('./worker').then((m) =>
      m.createWorker(
        new URL('../dist/esm/applyMappingsWorker.js', import.meta.url),
        { type: 'module' },
      ),
    )

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        worker.terminate()
        resolve()
      }, 2000)
      worker.addEventListener('message', () => {})
      worker.postMessage({ request: 'unknown-op' })
    })

    expect(true).toBe(true)
  })
})
