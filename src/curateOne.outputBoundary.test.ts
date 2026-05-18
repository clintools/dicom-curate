import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMinimalDicomFile } from '../testutils/minimalDicom'
import { curateOne } from './curateOne'
import type { TCurationSpecification, TFileInfo } from './types'

function modifyingSpec(newPatientId: string): () => TCurationSpecification {
  return () => ({
    version: '3.0',
    inputPathPattern: 'study/subject',
    hostProps: {},
    dicomPS315EOptions: 'Off',
    modifyDicomHeader: () => ({ PatientID: newPatientId }),
    outputFilePathComponents: () => ['curated', 'subject', 'out.dcm'],
    errors: () => [],
  })
}

describe('curateOne output boundary', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        chmodSync(d, 0o755)
      } catch {
        /* ignore */
      }
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('writes expected header modifications to the output file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-mod-'))
    dirs.push(root)
    const srcPath = join(root, 'study', 'subject', 'in.dcm')
    writeMinimalDicomFile(srcPath, { patientId: 'SOURCE-ID' })
    const outRoot = join(root, 'output')

    const result = await curateOne({
      fileInfo: {
        kind: 'path',
        fullPath: srcPath,
        path: 'study/subject',
        name: 'in.dcm',
        size: readFileSync(srcPath).length,
      },
      outputTarget: { directory: outRoot },
      mappingOptions: {
        curationSpec: modifyingSpec('CURATED-ID'),
        skipWrite: false,
      },
    })

    expect(result.outputFilePath).toMatch(/^curated\/subject\//)
    const outPath = join(outRoot, result.outputFilePath!)
    expect(existsSync(outPath)).toBe(true)
    expect(result.mappings?.PatientID?.[3]).toBe('CURATED-ID')
  })

  it('does not mutate the source file on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-src-'))
    dirs.push(root)
    const srcPath = join(root, 'study', 'subject', 'in.dcm')
    writeMinimalDicomFile(srcPath, { patientId: 'KEEP-ME' })
    const before = readFileSync(srcPath)

    await curateOne({
      fileInfo: {
        kind: 'path',
        fullPath: srcPath,
        path: 'study/subject',
        name: 'in.dcm',
        size: before.length,
      },
      outputTarget: { directory: join(root, 'output') },
      mappingOptions: {
        curationSpec: modifyingSpec('CHANGED'),
        skipWrite: false,
      },
    })

    const after = readFileSync(srcPath)
    expect(Buffer.compare(before, after)).toBe(0)
  })

  it('returns map results without throwing when output directory cannot be created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-fail-'))
    dirs.push(root)
    const srcPath = join(root, 'in.dcm')
    writeMinimalDicomFile(srcPath)
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'blocked')

    const result = await curateOne({
      fileInfo: {
        kind: 'path',
        fullPath: srcPath,
        path: 'study',
        name: 'in.dcm',
        size: readFileSync(srcPath).length,
      },
      outputTarget: { directory: blocker },
      mappingOptions: {
        curationSpec: modifyingSpec('X'),
        skipWrite: false,
      },
    })

    expect(result.outputFilePath).toMatch(/^curated\/subject\//)
    expect(existsSync(join(blocker, 'curated'))).toBe(false)
  })

  it('surfaces write failures via uploadErrors on HTTP output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-http-'))
    dirs.push(root)
    const srcPath = join(root, 'study', 'subject', 'in.dcm')
    writeMinimalDicomFile(srcPath)

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connection refused'))

    try {
      const result = await curateOne({
        fileInfo: {
          kind: 'path',
          fullPath: srcPath,
          path: 'study/subject',
          name: 'in.dcm',
          size: readFileSync(srcPath).length,
        },
        outputTarget: { http: { url: 'https://example.invalid/upload' } },
        mappingOptions: {
          curationSpec: modifyingSpec('X'),
          skipWrite: false,
        },
      })

      expect(result.outputUpload).toBeUndefined()
      expect(result.uploadErrors?.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('skips re-write when previousMappedFileInfo hash matches (partial recovery path)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-skip-'))
    dirs.push(root)
    const srcPath = join(root, 'study', 'subject', 'in.dcm')
    writeMinimalDicomFile(srcPath)
    const outRoot = join(root, 'output')

    const fileInfo: TFileInfo = {
      kind: 'path',
      fullPath: srcPath,
      path: 'study/subject',
      name: 'in.dcm',
      size: readFileSync(srcPath).length,
    }

    const first = await curateOne({
      fileInfo,
      outputTarget: { directory: outRoot },
      mappingOptions: {
        curationSpec: modifyingSpec('STABLE'),
        skipWrite: false,
      },
      hashMethod: 'md5',
    })
    const postHash = first.fileInfo?.postMappedHash
    expect(postHash).toBeDefined()

    const outPath = join(outRoot, first.outputFilePath!)
    const mtimeBefore = statSync(outPath).mtimeMs

    const second = await curateOne({
      fileInfo,
      outputTarget: { directory: outRoot },
      mappingOptions: {
        curationSpec: modifyingSpec('STABLE'),
        skipWrite: false,
      },
      hashMethod: 'md5',
      previousMappedFileInfo: async () => ({ postMappedHash: postHash }),
    })

    expect(second.mappingRequired).toBe(false)
    expect(statSync(outPath).mtimeMs).toBe(mtimeBefore)
  })

  it('places output files under the resolved output directory tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'out-tree-'))
    dirs.push(root)
    mkdirSync(join(root, 'nested', 'input'), { recursive: true })
    const srcPath = join(root, 'nested', 'input', 'scan.dcm')
    writeMinimalDicomFile(srcPath)
    const outRoot = join(root, 'dest')

    const result = await curateOne({
      fileInfo: {
        kind: 'path',
        fullPath: srcPath,
        path: 'nested/input',
        name: 'scan.dcm',
        size: readFileSync(srcPath).length,
      },
      outputTarget: { directory: outRoot },
      mappingOptions: {
        curationSpec: () => ({
          version: '3.0',
          inputPathPattern: 'nested/input',
          hostProps: {},
          dicomPS315EOptions: 'Off',
          modifyDicomHeader: () => ({}),
          outputFilePathComponents: () => ['mapped', 'input', 'scan.dcm'],
          errors: () => [],
        }),
        skipWrite: false,
      },
    })

    expect(existsSync(join(outRoot, result.outputFilePath!))).toBe(true)
  })
})
