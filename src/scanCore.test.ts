import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FileScanMsg, ScanFilters } from './scanCore'
import type { TS3BucketOptions } from './types'

// The S3 traversal loads the AWS SDK lazily via ./s3Client; mock it so the
// listing loop can be driven in-process without a live bucket.
const s3Send = vi.fn()
vi.mock('./s3Client', () => ({
  loadS3Client: async () => ({
    S3Client: class {
      send = s3Send
    },
    ListObjectsV2Command: class {
      constructor(public input: unknown) {}
    },
  }),
}))

const {
  cheapFilterNameOnly,
  isS3KeyExcludedByName,
  safeReadErrorMessage,
  ScanController,
  scanDirectory,
  scanDirectoryNode,
  scanS3Bucket,
  shouldProcessFileItem,
} = await import('./scanCore')

function defaultFilters(overrides: Partial<ScanFilters> = {}): ScanFilters {
  return {
    excludedFiletypes: [],
    excludedPathRegexes: [],
    noDicomSignatureCheck: false,
    noDefaultExclusions: false,
    ...overrides,
  }
}

function collector() {
  const msgs: FileScanMsg[] = []
  return { msgs, emit: (m: FileScanMsg) => msgs.push(m) }
}

function fileNames(msgs: FileScanMsg[]): string[] {
  return msgs
    .flatMap((m) => (m.response === 'file' ? [m.fileInfo.name] : []))
    .sort()
}

function anomalyTexts(msgs: FileScanMsg[]): string[] {
  return msgs.flatMap((m) =>
    m.response === 'scanAnomalies' ? m.anomalies : [],
  )
}

/** Messages carrying a hard error, as opposed to a benign anomaly. */
function errorMessages(msgs: FileScanMsg[]) {
  return msgs.flatMap((m) =>
    m.response === 'scanAnomalies' && m.errors?.length ? [m] : [],
  )
}

function countValues(msgs: FileScanMsg[]): number[] {
  return msgs.flatMap((m) =>
    m.response === 'count' ? [m.totalDiscovered] : [],
  )
}

const DICM_SIGNATURE_OFFSET = 128

/** Write a file that passes the scan worker's DICOM signature check. */
function writeDicom(path: string, size = 200): void {
  const buf = Buffer.alloc(size)
  buf.write('DICM', DICM_SIGNATURE_OFFSET, 'ascii')
  writeFileSync(path, buf)
}

/** Write a large-enough file that lacks the "DICM" signature. */
function writeNonDicom(path: string, size = 200): void {
  writeFileSync(path, Buffer.alloc(size))
}

describe('ScanController', () => {
  it('returns immediately from waitIfPaused when not paused', async () => {
    const controller = new ScanController()
    expect(await controller.waitIfPaused()).toBe(true)
  })

  it('blocks waitIfPaused until resumed', async () => {
    const controller = new ScanController()
    controller.pause()
    let settled = false
    const waiter = controller.waitIfPaused().then((v) => {
      settled = true
      return v
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.resume()
    expect(await waiter).toBe(true)
    expect(settled).toBe(true)
  })

  it('pause is idempotent and resume is a no-op when not paused', () => {
    const controller = new ScanController()
    controller.resume() // no pending pause — should be safe
    controller.pause()
    controller.pause() // second pause must not replace the pending promise
    controller.resume()
    expect(controller.keepScanning).toBe(true)
  })
})

describe('safeReadErrorMessage', () => {
  it('prefers the error code, then name, then a generic fallback', () => {
    expect(safeReadErrorMessage({ code: 'ENOENT' })).toBe(
      'Unable to read file (filesystem error): ENOENT',
    )
    expect(safeReadErrorMessage({ name: 'AbortError' })).toBe(
      'Unable to read file (filesystem error): AbortError',
    )
    expect(safeReadErrorMessage('boom')).toBe(
      'Unable to read file (filesystem error): unknown error',
    )
  })

  it('never leaks a raw fs error message (which embeds the path)', () => {
    const err: Error & { code?: string } = new Error(
      "ENOENT: no such file, stat '/phi/patient.dcm'",
    )
    err.code = 'ENOENT'
    const msg = safeReadErrorMessage(err)
    expect(msg).not.toContain('/phi/patient.dcm')
    expect(msg).toBe('Unable to read file (filesystem error): ENOENT')
  })
})

describe('scanDirectoryNode', () => {
  const trees: string[] = []

  afterEach(() => {
    for (const t of trees.splice(0)) {
      rmSync(t, { recursive: true, force: true })
    }
  })

  function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'scancore-node-'))
    trees.push(root)
    const nested = join(root, 'level1', 'nested')
    mkdirSync(nested, { recursive: true })
    writeDicom(join(root, 'level1', 'root_valid.dcm'))
    writeDicom(join(nested, 'nested_valid.dcm'))
    writeNonDicom(join(root, 'readme.txt'))
    writeFileSync(join(root, 'tiny.bin'), 'x')
    return root
  }

  async function run(
    root: string,
    filters = defaultFilters(),
    previousIndex?: Record<string, { size?: number; mtime?: string }>,
  ) {
    const { msgs, emit } = collector()
    await scanDirectoryNode(root, {
      filters,
      controller: new ScanController(),
      previousIndex,
      emit,
    })
    return msgs
  }

  it('discovers valid DICOM files across nested directories', async () => {
    const msgs = await run(makeTree())
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['nested_valid.dcm', 'root_valid.dcm'])
  })

  it('emits anomalies for non-DICOM and very small files', async () => {
    const texts = anomalyTexts(await run(makeTree()))
    expect(texts.some((t) => t.includes('DICOM signature'))).toBe(true)
    expect(texts.some((t) => t.includes('very small'))).toBe(true)
  })

  it('skips default-excluded filetypes and corrects the count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-excl-'))
    trees.push(root)
    writeDicom(join(root, 'good.dcm'))
    writeFileSync(join(root, 'DICOMDIR'), Buffer.alloc(200))

    const msgs = await run(root)
    expect(fileNames(msgs)).toEqual(['good.dcm'])
    expect(
      anomalyTexts(msgs).some((t) => t.toLowerCase().includes('dicomdir')),
    ).toBe(true)
    // Counter counts good.dcm only (DICOMDIR fails the cheap name filter too),
    // so the final count settles at 1.
    const counts = countValues(msgs)
    expect(counts[counts.length - 1]).toBe(1)
  })

  it('keeps default-excluded filetypes when noDefaultExclusions is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-nodef-'))
    trees.push(root)
    writeDicom(join(root, 'DICOMDIR'))

    const msgs = await run(root, defaultFilters({ noDefaultExclusions: true }))
    expect(fileNames(msgs)).toEqual(['DICOMDIR'])
  })

  it('emits every file when noDicomSignatureCheck is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-nosig-'))
    trees.push(root)
    writeNonDicom(join(root, 'plain.bin'))

    const msgs = await run(
      root,
      defaultFilters({ noDicomSignatureCheck: true }),
    )
    expect(fileNames(msgs)).toEqual(['plain.bin'])
  })

  it('silently skips files matching an excluded path regex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-regex-'))
    trees.push(root)
    writeDicom(join(root, 'keep.dcm'))
    writeDicom(join(root, 'drop.dcm'))

    const msgs = await run(
      root,
      defaultFilters({ excludedPathRegexes: [/drop\.dcm$/] }),
    )
    expect(fileNames(msgs)).toEqual(['keep.dcm'])
    // Silent skip: no anomaly for the excluded-path file.
    expect(anomalyTexts(msgs)).toEqual([])
  })

  it('attaches previousFileInfo from the index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-index-'))
    trees.push(root)
    writeDicom(join(root, 'indexed.dcm'))
    const key = `${basename(root)}/indexed.dcm`

    const msgs = await run(root, defaultFilters(), {
      [key]: { size: 999, mtime: '2020-01-01T00:00:00.000Z' },
    })
    const fileMsg = msgs.find((m) => m.response === 'file') as Extract<
      FileScanMsg,
      { response: 'file' }
    >
    expect(fileMsg.previousFileInfo?.size).toBe(999)
    expect(fileMsg.previousFileInfo?.mtime).toBe('2020-01-01T00:00:00.000Z')
  })

  // Root ignores permission bits, so the stat-failure trick cannot fire there.
  it.skipIf(process.getuid?.() === 0)(
    'surfaces an unreadable file as a PHI-safe error and corrects the count',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'scancore-readerr-'))
      trees.push(root)
      const sub = join(root, 'sub')
      mkdirSync(sub)
      writeDicom(join(sub, 'locked.dcm'))
      // Readable (so readdir lists it) but not searchable (so stat throws EACCES).
      chmodSync(sub, 0o400)
      try {
        const msgs = await run(root)
        const errorMsgs = errorMessages(msgs)
        expect(errorMsgs).toHaveLength(1)
        expect(errorMsgs[0].errors?.[0]).toContain(
          'Unable to read file (filesystem error)',
        )
        // PHI-safe: the raw filename must not appear in the error string.
        expect(errorMsgs[0].errors?.[0]).not.toContain('locked.dcm')
        expect(errorMsgs[0].fileInfo.name).toBe('locked.dcm')
      } finally {
        // Restore search permission so afterEach cleanup can remove the tree.
        chmodSync(sub, 0o700)
      }
    },
  )

  it('reports a scan error rather than throwing for a missing directory', async () => {
    const msgs = await run(join(tmpdir(), 'scancore-does-not-exist-xyz'))
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' && m.error.includes('Directory scan failed'),
      ),
    ).toBe(true)
  })
})

describe('scanDirectory (browser FileSystem handles)', () => {
  class FakeFileHandle {
    kind = 'file' as const
    constructor(
      public name: string,
      private file: File,
      private failRead = false,
    ) {}
    async getFile(): Promise<File> {
      if (this.failRead) throw new Error('handle read failed')
      return this.file
    }
  }

  class FakeDirHandle {
    kind = 'directory' as const
    constructor(
      public name: string,
      private entries: Array<FakeFileHandle | FakeDirHandle>,
    ) {}
    async *values() {
      for (const entry of this.entries) yield entry
    }
  }

  function dicomFile(name: string, size = 200): File {
    const buf = Buffer.alloc(size)
    buf.write('DICM', DICM_SIGNATURE_OFFSET, 'ascii')
    return new File([buf], name)
  }

  async function run(root: FakeDirHandle, filters = defaultFilters()) {
    const { msgs, emit } = collector()
    await scanDirectory(root as unknown as FileSystemDirectoryHandle, {
      filters,
      controller: new ScanController(),
      emit,
    })
    return msgs
  }

  it('discovers valid DICOM files, recursing into subdirectories', async () => {
    const tree = new FakeDirHandle('root', [
      new FakeFileHandle('a.dcm', dicomFile('a.dcm')),
      new FakeDirHandle('sub', [
        new FakeFileHandle('b.dcm', dicomFile('b.dcm')),
        new FakeFileHandle(
          'note.txt',
          new File([Buffer.alloc(200)], 'note.txt'),
        ),
      ]),
    ])
    const msgs = await run(tree)
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm'])
    expect(anomalyTexts(msgs).some((t) => t.includes('DICOM signature'))).toBe(
      true,
    )
  })

  it('treats an unreadable handle as a non-fatal error and continues', async () => {
    const tree = new FakeDirHandle('root', [
      new FakeFileHandle('bad.dcm', dicomFile('bad.dcm'), true),
      new FakeFileHandle('good.dcm', dicomFile('good.dcm')),
    ])
    const msgs = await run(tree)
    expect(fileNames(msgs)).toEqual(['good.dcm'])
    const errorMsgs = errorMessages(msgs)
    expect(errorMsgs).toHaveLength(1)
    expect(errorMsgs[0].errors?.[0]).toContain(
      'Unable to read file (filesystem error)',
    )
    expect(errorMsgs[0].fileInfo.name).toBe('bad.dcm')
  })

  it('reports a scan error when traversal throws', async () => {
    const exploding = {
      name: 'root',
      values() {
        throw new Error('iterator blew up')
      },
    }
    const { msgs, emit } = collector()
    await scanDirectory(exploding as unknown as FileSystemDirectoryHandle, {
      filters: defaultFilters(),
      controller: new ScanController(),
      emit,
    })
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' && m.error.includes('Directory scan failed'),
      ),
    ).toBe(true)
  })
})

describe('shouldProcessFileItem (S3 object predicate)', () => {
  it('excludes objects matching an excluded path regex (silent)', async () => {
    const anomalies: string[] = []
    const ok = await shouldProcessFileItem(
      { Key: 'skip/here.dcm', Size: 500 },
      anomalies,
      defaultFilters({ excludedPathRegexes: [/skip\//] }),
    )
    expect(ok).toBe(false)
    expect(anomalies).toEqual([])
  })

  it('excludes default-excluded object names with an anomaly', async () => {
    const anomalies: string[] = []
    const ok = await shouldProcessFileItem(
      { Key: 'study/DICOMDIR', Size: 500 },
      anomalies,
      defaultFilters(),
    )
    expect(ok).toBe(false)
    expect(anomalies.some((a) => a.includes('DICOMDIR'))).toBe(true)
  })

  it('flags very small objects', async () => {
    const anomalies: string[] = []
    const ok = await shouldProcessFileItem(
      { Key: 'study/tiny.dcm', Size: 10 },
      anomalies,
      defaultFilters(),
    )
    expect(ok).toBe(false)
    expect(anomalies.some((a) => a.includes('very small'))).toBe(true)
  })

  it('accepts a normal object (no signature check possible for S3)', async () => {
    const anomalies: string[] = []
    const ok = await shouldProcessFileItem(
      { Key: 'study/scan.dcm', Size: 5000 },
      anomalies,
      defaultFilters(),
    )
    expect(ok).toBe(true)
    expect(anomalies).toEqual([])
  })
})

describe('scanS3Bucket', () => {
  beforeEach(() => {
    s3Send.mockReset()
  })

  const bucketOptions = {
    bucketName: 'bucket',
    region: 'us-east-1',
  } as unknown as TS3BucketOptions

  async function run(filters = defaultFilters()) {
    const { msgs, emit } = collector()
    await scanS3Bucket(bucketOptions, {
      filters,
      controller: new ScanController(),
      emit,
    })
    return msgs
  }

  it('pages through the listing, emitting files, anomalies and counts', async () => {
    s3Send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'study/a.dcm', Size: 5000 },
          { Key: 'study/DICOMDIR', Size: 5000 },
        ],
        NextContinuationToken: 'page2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'study/b.dcm', Size: 5000 }],
      })

    const msgs = await run()
    expect(fileNames(msgs)).toEqual(['study/a.dcm', 'study/b.dcm'])
    expect(anomalyTexts(msgs).some((t) => t.includes('DICOMDIR'))).toBe(true)
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    const counts = msgs.filter((m) => m.response === 'count')
    expect(counts.length).toBeGreaterThanOrEqual(2)
    expect(s3Send).toHaveBeenCalledTimes(2)
  })

  it('emits a scan error when the S3 client throws', async () => {
    s3Send.mockRejectedValueOnce(new Error('access denied'))
    const msgs = await run()
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' && m.error.includes('S3 bucket scan failed'),
      ),
    ).toBe(true)
  })
})

describe('cheapFilterNameOnly', () => {
  it('rejects excluded-path and excluded-name entries, accepts others', () => {
    const filters = defaultFilters({
      excludedFiletypes: ['skip.dcm'],
      excludedPathRegexes: [/private\//],
    })
    expect(cheapFilterNameOnly('keep.dcm', 'root/keep.dcm', filters)).toBe(true)
    expect(cheapFilterNameOnly('skip.dcm', 'root/skip.dcm', filters)).toBe(
      false,
    )
    expect(cheapFilterNameOnly('any.dcm', 'private/any.dcm', filters)).toBe(
      false,
    )
    expect(cheapFilterNameOnly('DICOMDIR', 'root/DICOMDIR', filters)).toBe(
      false,
    )
  })
})

describe('isS3KeyExcludedByName (re-exported from scanDirectoryWorker too)', () => {
  it('matches the bare object name against defaults and extras', () => {
    expect(isS3KeyExcludedByName('a/b/DICOMDIR', [], true)).toBe(true)
    expect(isS3KeyExcludedByName('a/b/DICOMDIR', [], false)).toBe(false)
    expect(isS3KeyExcludedByName('a/notes.txt', ['notes.txt'], false)).toBe(
      true,
    )
    expect(isS3KeyExcludedByName('a/scan.dcm', [], true)).toBe(false)
  })
})
