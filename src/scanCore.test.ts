import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import type { FileScanFileMsg } from '../testutils/workerTestHelpers'
import type { FileScanMsg, ScanFilters } from './scanCore'
import type { TInputPath, TS3BucketOptions, TS3Credentials } from './types'

// The S3 traversal loads the AWS SDK lazily via ./s3Client; mock it so the
// listing loop can be driven in-process without a live bucket.
const s3Send = vi.fn()
const s3ClientConfigs: { credentials?: unknown }[] = []
const s3Destroy = vi.fn()
const loadS3Client = vi.fn(async () => ({
  S3Client: class {
    send = s3Send
    destroy = s3Destroy
    constructor(config: { credentials?: unknown }) {
      s3ClientConfigs.push(config)
    }
  },
  ListObjectsV2Command: class {
    constructor(public input: unknown) {}
  },
}))
vi.mock('./s3Client', () => ({ loadS3Client }))

// Backoff resolves at once; tests assert the requested waits instead.
vi.mock('./delay', () => ({ delay: vi.fn(async () => {}) }))

// Passthrough, so a test can fail chosen listings or change realpath.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
  }
})

const { delay } = await import('./delay')
const fsPromises = await import('fs/promises')
const { readdir: realReaddir, realpath: realRealpath } =
  await vi.importActual<typeof import('fs/promises')>('fs/promises')
const readdirMock = vi.mocked(fsPromises.readdir)
const realpathMock = vi.mocked(fsPromises.realpath)

const {
  cheapFilterNameOnly,
  createScanHandler,
  isS3KeyExcludedByName,
  LIST_RETRY_DELAYS_MS,
  safeReadErrorMessage,
  ScanController,
  scanDirectory,
  scanDirectoryNode,
  scanListedHandles,
  scanListedNodePaths,
  scanListedS3Keys,
  relativeNodePath,
  scanS3Bucket,
  shouldProcessFileItem,
  MISSING_KEY_ERROR,
  NOT_A_FILE_ERROR,
  UNLOCATED_INPUT_ERROR,
} = await import('./scanCore')

beforeEach(() => {
  s3Send.mockReset()
  s3Destroy.mockReset()
  s3ClientConfigs.length = 0
})

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

function requestedDelays(): number[] {
  return vi.mocked(delay).mock.calls.map(([ms]) => ms)
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
    await expect(controller.waitIfPaused()).resolves.toBeUndefined()
  })

  it('blocks waitIfPaused until resumed', async () => {
    const controller = new ScanController()
    controller.pause()
    let settled = false
    const waiter = controller.waitIfPaused().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.resume()
    await waiter
    expect(settled).toBe(true)
  })

  it('pause is idempotent and resume is a no-op when not paused', async () => {
    const controller = new ScanController()
    controller.resume() // no pending pause — should be safe
    controller.pause()
    const waiter = controller.waitIfPaused()
    controller.pause() // second pause must not replace the pending promise
    controller.resume()
    // A replaced promise would strand this waiter's resolver and time out.
    await expect(waiter).resolves.toBeUndefined()
    await expect(controller.waitIfPaused()).resolves.toBeUndefined()
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
    readdirMock.mockImplementation(realReaddir)
    vi.mocked(delay).mockClear()
  })

  function failListing(dirPath: string, times: number): void {
    let left = times
    readdirMock.mockImplementation(((target: string, options: unknown) =>
      target === dirPath && left-- > 0
        ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
        : realReaddir(target, options as never)) as typeof realReaddir)
  }

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

  it('retries a sub-directory listing that fails once', async () => {
    const root = makeTree()
    failListing(join(root, 'level1'), 1)
    const msgs = await run(root)
    expect(errorMessages(msgs)).toHaveLength(0)
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['nested_valid.dcm', 'root_valid.dcm'])
    expect(requestedDelays()).toEqual([LIST_RETRY_DELAYS_MS[0]])
  })

  it('reports a sub-directory that never lists and continues with its siblings', async () => {
    const root = makeTree()
    failListing(join(root, 'level1', 'nested'), Infinity)
    const msgs = await run(root)
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['root_valid.dcm'])
    const errorMsgs = errorMessages(msgs)
    expect(errorMsgs).toHaveLength(1)
    expect(errorMsgs[0].errors).toEqual([
      'Unable to list directory (filesystem error): EIO',
    ])
    expect(errorMsgs[0].fileInfo.name).toBe('nested')
    expect(errorMsgs[0].scanTarget).toBe('directory')
    expect(countValues(msgs).at(-1)).toBe(1)
  })

  it('keeps counting past a sub-directory the counter cannot list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-node-'))
    trees.push(root)
    const bad = join(root, 'a_bad')
    for (const dir of [bad, join(root, 'b'), join(root, 'c')]) mkdirSync(dir)
    writeDicom(join(bad, 'w.dcm'))
    writeDicom(join(root, 'b', 'x.dcm'))
    writeDicom(join(root, 'c', 'y.dcm'))
    // The counter lists the root first. Hold the feeder's listing until the
    // counter has counted both siblings, or for a second if it never does.
    // a_bad fails each of the counter's attempts, then lists for the feeder.
    let release!: () => void
    const counted = new Promise<void>((resolve) => (release = resolve))
    const fallback = setTimeout(() => release(), 1000)
    let rootListings = 0
    let badFailures = LIST_RETRY_DELAYS_MS.length + 1
    readdirMock.mockImplementation(((target: string, options: unknown) => {
      if (target === bad && badFailures-- > 0) {
        return Promise.reject(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        )
      }
      const listing = () => realReaddir(target, options as never)
      return target === root && ++rootListings === 2
        ? counted.then(listing)
        : listing()
    }) as typeof realReaddir)

    const msgs: FileScanMsg[] = []
    await scanDirectoryNode(root, {
      filters: defaultFilters(),
      controller: new ScanController(),
      emit: (msg) => {
        msgs.push(msg)
        if (msg.response === 'count' && msg.totalDiscovered === 2) release()
      },
    })
    clearTimeout(fallback)

    const firstFile = msgs.findIndex((m) => m.response === 'file')
    expect(countValues(msgs.slice(0, firstFile))).toEqual([1, 2])
    expect(fileNames(msgs)).toEqual(['w.dcm', 'x.dcm', 'y.dcm'])
    expect(errorMessages(msgs)).toHaveLength(0)
    // Then one per file fed: the counter's 2 holds until the feeder passes it.
    expect(countValues(msgs)).toEqual([1, 2, 2, 2, 3, 3])
  })

  it('reports a scan error rather than throwing for a missing directory', async () => {
    const msgs = await run(join(tmpdir(), 'scancore-does-not-exist-xyz'))
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' && m.error.includes('Directory scan failed'),
      ),
    ).toBe(true)
  })

  it('retries the root listing before failing the scan', async () => {
    const root = makeTree()
    failListing(root, Infinity)
    const msgs = await run(root)
    expect(msgs.some((m) => m.response === 'error')).toBe(true)
    // Counter and feeder each list the root.
    expect(requestedDelays().sort((a, b) => a - b)).toEqual(
      [...LIST_RETRY_DELAYS_MS, ...LIST_RETRY_DELAYS_MS].sort((a, b) => a - b),
    )
  })
})

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

/** Failures and case-folding are off by default. */
class FakeDirHandle {
  kind = 'directory' as const
  dirLookups = 0
  matchCase = true
  failLookups = 0
  failFileLookups = 0
  failListings = 0
  constructor(
    public name: string,
    private entries: Array<{ name: string; kind: 'file' | 'directory' }>,
  ) {}
  async *values() {
    if (this.failListings-- > 0) {
      throw new DOMException('busy', 'NotReadableError')
    }
    for (const entry of this.entries) yield entry
  }
  private find(name: string, kind: 'file' | 'directory') {
    const found = this.entries.find(
      (e) =>
        e.kind === kind &&
        (this.matchCase
          ? e.name === name
          : e.name.toLowerCase() === name.toLowerCase()),
    )
    if (!found) throw new DOMException('not found', 'NotFoundError')
    return found
  }
  async getDirectoryHandle(name: string) {
    this.dirLookups++
    if (this.failLookups-- > 0) {
      throw new DOMException('busy', 'NotReadableError')
    }
    return this.find(name, 'directory')
  }
  async getFileHandle(name: string) {
    if (this.failFileLookups-- > 0) {
      throw new DOMException('busy', 'NotReadableError')
    }
    return this.find(name, 'file')
  }
}

function dicomFile(name: string, size = 200): File {
  const buf = Buffer.alloc(size)
  buf.write('DICM', DICM_SIGNATURE_OFFSET, 'ascii')
  return new File([buf], name)
}

describe('scanDirectory (browser FileSystem handles)', () => {
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

  // Throws on the values() calls numbered in `failCalls` after yielding
  // `yieldFirst` entries (or as many as it returns for the call number), like
  // a dropped network share.
  class FlakyDirHandle {
    kind = 'directory' as const
    private calls = 0
    constructor(
      public name: string,
      private entries: FakeFileHandle[],
      private failCalls: number[],
      private yieldFirst: number | ((call: number) => number) = 0,
    ) {}
    async *values() {
      const call = ++this.calls
      const fail = this.failCalls.includes(call)
      const first =
        typeof this.yieldFirst === 'function'
          ? this.yieldFirst(call)
          : this.yieldFirst
      const entries = fail ? this.entries.slice(0, first) : this.entries
      for (const entry of entries) yield entry
      if (fail) throw new DOMException('state had changed', 'InvalidStateError')
    }
  }

  class GatedFileHandle extends FakeFileHandle {
    constructor(
      name: string,
      file: File,
      private gate: Promise<void>,
    ) {
      super(name, file)
    }
    async getFile(): Promise<File> {
      await this.gate
      return super.getFile()
    }
  }

  // Holds the feeder on the first file until the counter, which awaits only
  // microtasks here, has walked the tree: the counter makes the first
  // values() calls on `flaky`, the feeder the rest.
  async function runCounterFirst(
    flaky: FlakyDirHandle,
    before: FakeFileHandle[] = [],
  ) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const msgs = run(
      new FakeDirHandle('root', [
        new GatedFileHandle('a.dcm', dicomFile('a.dcm'), gate),
        ...before,
        flaky,
        new FakeFileHandle('z.dcm', dicomFile('z.dcm')),
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    return msgs
  }

  const ATTEMPTS = LIST_RETRY_DELAYS_MS.length + 1
  const calls = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => from + i)

  afterEach(() => vi.mocked(delay).mockClear())

  it.each([
    ['the counter', [1]],
    ['the feeder', [2]],
  ])('recovers when %s fails to list once', async (_lister, failCalls) => {
    const b = new FakeFileHandle('b.dcm', dicomFile('b.dcm'))
    const msgs = await runCounterFirst(
      new FlakyDirHandle('sub', [b], failCalls),
    )
    expect(errorMessages(msgs)).toHaveLength(0)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm', 'z.dcm'])
    expect(countValues(msgs).at(-1)).toBe(3)
    expect(requestedDelays()).toEqual([LIST_RETRY_DELAYS_MS[0]])
  })

  it('emits each entry once when a listing fails part-way and recovers', async () => {
    const entries = ['b.dcm', 'c.dcm'].map(
      (name) => new FakeFileHandle(name, dicomFile(name)),
    )
    const msgs = await runCounterFirst(
      new FlakyDirHandle('sub', entries, [2], 1),
    )
    expect(errorMessages(msgs)).toHaveLength(0)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm', 'c.dcm', 'z.dcm'])
  })

  it('keeps counting past a sub-directory the counter never lists', async () => {
    const b = new FakeFileHandle('b.dcm', dicomFile('b.dcm'))
    const m = new FakeFileHandle('m.dcm', dicomFile('m.dcm'))
    const msgs = await runCounterFirst(
      new FlakyDirHandle('sub', [b], calls(1, ATTEMPTS)),
      [m],
    )
    expect(msgs.some((msg) => msg.response === 'error')).toBe(false)
    expect(errorMessages(msgs)).toHaveLength(0)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm', 'm.dcm', 'z.dcm'])
    // Counter's a.dcm, m.dcm and, past sub, z.dcm; then one per file fed: the
    // counter's 3 holds until the feeder passes it. Then the final sync.
    expect(countValues(msgs)).toEqual([1, 2, 3, 3, 3, 3, 4, 4])
  })

  it('keeps retrying a listing that makes progress between failures', async () => {
    const entries = ['b', 'c', 'd', 'e', 'f', 'g'].map(
      (name) => new FakeFileHandle(`${name}.dcm`, dicomFile(`${name}.dcm`)),
    )
    // The counter lists cleanly (call 1). Each feeder call c fails after one
    // more entry than the last, more often than a stall's retries allow.
    const failures = ATTEMPTS + 1
    const msgs = await runCounterFirst(
      new FlakyDirHandle('sub', entries, calls(2, failures), (c) => c - 1),
    )
    expect(errorMessages(msgs)).toHaveLength(0)
    expect(fileNames(msgs)).toHaveLength(entries.length + 2)
    expect(requestedDelays()).toEqual(
      Array(failures).fill(LIST_RETRY_DELAYS_MS[0]),
    )
  })

  it('reports a sub-directory the feeder never lists and continues with its siblings', async () => {
    const b = new FakeFileHandle('b.dcm', dicomFile('b.dcm'))
    const msgs = await runCounterFirst(
      new FlakyDirHandle('bad', [b], calls(2, ATTEMPTS)),
    )
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'z.dcm'])
    const errorMsgs = errorMessages(msgs)
    expect(errorMsgs).toHaveLength(1)
    expect(errorMsgs[0].errors).toEqual([
      'Unable to list directory (filesystem error): InvalidStateError',
    ])
    expect(errorMsgs[0].fileInfo.name).toBe('bad')
    expect(errorMsgs[0].scanTarget).toBe('directory')
    // The counter counted b.dcm; the final sync corrects it.
    expect(countValues(msgs)).toEqual([1, 2, 3, 2])
    expect(requestedDelays()).toEqual(LIST_RETRY_DELAYS_MS)
  })

  it('reports a sub-directory that neither lister can list', async () => {
    const b = new FakeFileHandle('b.dcm', dicomFile('b.dcm'))
    const msgs = await runCounterFirst(
      new FlakyDirHandle('bad', [b], calls(1, 2 * ATTEMPTS)),
    )
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
    expect(fileNames(msgs)).toEqual(['a.dcm', 'z.dcm'])
    expect(errorMessages(msgs)).toHaveLength(1)
    expect(countValues(msgs).at(-1)).toBe(2)
    expect(requestedDelays()).toEqual([
      ...LIST_RETRY_DELAYS_MS,
      ...LIST_RETRY_DELAYS_MS,
    ])
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
  const bucketOptions = {
    bucketName: 'bucket',
    region: 'us-east-1',
  } as unknown as TS3BucketOptions

  async function run(
    filters = defaultFilters(),
    requestCredentials: () => Promise<TS3Credentials | undefined> = async () =>
      undefined,
  ) {
    const { msgs, emit } = collector()
    await scanS3Bucket(
      bucketOptions,
      {
        filters,
        controller: new ScanController(),
        emit,
      },
      requestCredentials,
    )
    return msgs
  }

  function twoPages() {
    s3Send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'study/a.dcm', Size: 5000 }],
        NextContinuationToken: 'page2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'study/b.dcm', Size: 5000 }],
      })
  }

  it('signs each page with credentials requested for it', async () => {
    twoPages()
    let n = 0
    const requestCredentials = vi.fn(async () => ({
      accessKeyId: `KEY${++n}`,
      secretAccessKey: 'secret',
    }))

    const msgs = await run(defaultFilters(), requestCredentials)

    expect(fileNames(msgs)).toEqual(['study/a.dcm', 'study/b.dcm'])
    expect(requestCredentials).toHaveBeenCalledTimes(2)
    expect(s3Destroy).toHaveBeenCalledTimes(2)
    expect(s3ClientConfigs.map((c) => c.credentials)).toEqual([
      { accessKeyId: 'KEY1', secretAccessKey: 'secret' },
      { accessKeyId: 'KEY2', secretAccessKey: 'secret' },
    ])
  })

  it('leaves each page to the SDK default chain when the run has no credentials', async () => {
    twoPages()

    await run()

    expect(s3ClientConfigs).toHaveLength(2)
    expect(s3ClientConfigs.every((c) => c.credentials === undefined)).toBe(true)
  })

  it('emits a scan error when the credentials request is refused', async () => {
    const msgs = await run(defaultFilters(), async () => {
      throw new Error('credential source unavailable')
    })

    expect(s3Send).not.toHaveBeenCalled()
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' &&
          m.error.includes('credential source unavailable'),
      ),
    ).toBe(true)
  })

  it('holds files back while paused and emits them on resume', async () => {
    twoPages()
    const { msgs, emit } = collector()
    const controller = new ScanController()
    controller.pause()

    const scan = scanS3Bucket(
      bucketOptions,
      { filters: defaultFilters(), controller, emit },
      async () => undefined,
    )
    await vi.waitFor(() => expect(s3Send).toHaveBeenCalledTimes(1))
    expect(fileNames(msgs)).toEqual([])

    controller.resume()
    await scan

    expect(fileNames(msgs)).toEqual(['study/a.dcm', 'study/b.dcm'])
  })

  it('queues files without a copy of the bucket options', async () => {
    twoPages()

    const msgs = await run()

    const s3Files = msgs.flatMap((m) =>
      m.response === 'file' && m.fileInfo.kind === 's3' ? [m.fileInfo] : [],
    )
    expect(s3Files).toHaveLength(2)
    expect(s3Files.every((f) => f.bucketOptions === undefined)).toBe(true)
  })

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
    expect(s3Destroy).toHaveBeenCalledTimes(1)
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

describe('createScanHandler', () => {
  const trees: string[] = []

  afterEach(() => {
    for (const t of trees.splice(0)) {
      rmSync(t, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  function makeHandler() {
    const { msgs, emit } = collector()
    const close = vi.fn()
    const { handleMessage } = createScanHandler({ emit, close })
    return {
      msgs,
      close,
      send: (data: unknown) => handleMessage({ data } as MessageEvent),
    }
  }

  function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'scancore-handler-'))
    trees.push(root)
    writeDicom(join(root, 'valid.dcm'))
    return root
  }

  it('dispatches a path request to the node traversal, then closes', async () => {
    const { msgs, close, send } = makeHandler()

    send({ request: 'scan', path: makeTree() })

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(fileNames(msgs)).toEqual(['valid.dcm'])
    expect(msgs.some((m) => m.response === 'done')).toBe(true)
  })

  it('compiles the excluded path regexes carried on the request', async () => {
    const root = makeTree()
    writeDicom(join(root, 'skipme.dcm'))
    const { msgs, close, send } = makeHandler()

    send({ request: 'scan', path: root, excludedPathRegexes: ['skipme'] })

    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(fileNames(msgs)).toEqual(['valid.dcm'])
  })

  async function startS3Scan(handler: ReturnType<typeof makeHandler>) {
    handler.send({ request: 'scan', bucketOptions: { bucketName: 'bucket' } })
    await vi.waitFor(() =>
      expect(
        handler.msgs.some((m) => m.response === 's3CredentialsRequest'),
      ).toBe(true),
    )
  }

  it('answers listing credentials through the main thread', async () => {
    s3Send.mockResolvedValueOnce({
      Contents: [{ Key: 'study/a.dcm', Size: 5000 }],
    })
    const handler = makeHandler()
    const { msgs, close, send } = handler

    await startS3Scan(handler)
    send({
      request: 's3Credentials',
      credentials: { accessKeyId: 'KEY', secretAccessKey: 'secret' },
    })

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(fileNames(msgs)).toEqual(['study/a.dcm'])
    expect(s3ClientConfigs[0].credentials).toEqual({
      accessKeyId: 'KEY',
      secretAccessKey: 'secret',
    })
  })

  it('fails the listing when the main thread reports a credentials error', async () => {
    const handler = makeHandler()
    const { msgs, close, send } = handler

    await startS3Scan(handler)
    send({ request: 's3Credentials', error: 'credential source unavailable' })

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(
      msgs.some(
        (m) =>
          m.response === 'error' &&
          m.error.includes('credential source unavailable'),
      ),
    ).toBe(true)
  })

  it('reports missing directory information and leaves the port open', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { msgs, close, send } = makeHandler()

    send({ request: 'scan' })

    expect(logged).toHaveBeenCalledWith(
      'No valid directory information provided for scanning.',
    )
    expect(close).not.toHaveBeenCalled()
    expect(msgs).toEqual([])
  })

  it('reports an unknown request', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    makeHandler().send({ request: 'no-such-op' })

    expect(logged).toHaveBeenCalledWith('Unknown request no-such-op')
  })

  it('ignores stop and resume when no scan is in flight', () => {
    const { msgs, close, send } = makeHandler()

    send({ request: 'stop' })
    send({ request: 'resume' })

    expect(close).not.toHaveBeenCalled()
    expect(msgs).toEqual([])
  })

  it('routes stop and resume to the scan in flight', async () => {
    const pause = vi.spyOn(ScanController.prototype, 'pause')
    const resume = vi.spyOn(ScanController.prototype, 'resume')
    const { close, send } = makeHandler()

    send({ request: 'scan', path: makeTree() })
    send({ request: 'stop' })
    send({ request: 'resume' })

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
  })

  it('clears the controller once the scan settles', async () => {
    const { close, send } = makeHandler()
    send({ request: 'scan', path: makeTree() })
    await vi.waitFor(() => expect(close).toHaveBeenCalled())

    const pause = vi.spyOn(ScanController.prototype, 'pause')
    send({ request: 'stop' })

    expect(pause).not.toHaveBeenCalled()
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

describe('listed scans (inputPaths)', () => {
  const trees: string[] = []

  afterEach(() => {
    for (const t of trees.splice(0)) {
      rmSync(t, { recursive: true, force: true })
    }
    readdirMock.mockImplementation(realReaddir)
    realpathMock.mockImplementation(realRealpath)
    vi.mocked(delay).mockClear()
  })

  function ctx(emit: (m: FileScanMsg) => void, filters = defaultFilters()) {
    return { filters, controller: new ScanController(), emit }
  }

  function fileMsgs(msgs: FileScanMsg[]) {
    return msgs.filter((m): m is FileScanFileMsg => m.response === 'file')
  }

  describe('node paths', () => {
    function makeTree(): string {
      const root = mkdtempSync(join(tmpdir(), 'scancore-listed-'))
      trees.push(root)
      mkdirSync(join(root, 'level1', 'nested'), { recursive: true })
      writeDicom(join(root, 'level1', 'root_valid.dcm'))
      writeDicom(join(root, 'level1', 'nested', 'nested_valid.dcm'), 300)
      writeNonDicom(join(root, 'readme.txt'))
      return root
    }

    async function runListed(
      root: string,
      inputPaths: TInputPath[],
      filters = defaultFilters(),
    ) {
      const { msgs, emit } = collector()
      await scanListedNodePaths(root, inputPaths, ctx(emit, filters))
      return msgs
    }

    it('reports a listed file with the fileInfo and previousFileInfo a walk reports', async () => {
      const root = makeTree()
      const dirPath = `${basename(root)}/level1/nested`
      const previousIndex = {
        [`${dirPath}/nested_valid.dcm`]: { size: 300, mtime: 'earlier' },
      }
      const walked = collector()
      await scanDirectoryNode(root, {
        ...ctx(walked.emit),
        previousIndex,
      })
      const listed = collector()
      await scanListedNodePaths(
        root,
        [{ path: dirPath, name: 'nested_valid.dcm' }],
        { ...ctx(listed.emit), previousIndex },
      )

      const fromWalk = fileMsgs(walked.msgs).filter(
        (m) => m.fileInfo.name === 'nested_valid.dcm',
      )
      expect(fromWalk).toHaveLength(1)
      expect(fileMsgs(listed.msgs)).toEqual(fromWalk)
      expect(listed.msgs.at(-1)).toEqual({ response: 'done' })
    })

    it('applies the full filter and counts a rejected entry out of the total', async () => {
      const root = makeTree()
      const msgs = await runListed(root, [
        { path: basename(root), name: 'readme.txt' },
        { path: `${basename(root)}/level1`, name: 'root_valid.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['root_valid.dcm'])
      expect(
        anomalyTexts(msgs).some((t) => t.includes('DICOM signature')),
      ).toBe(true)
      expect(countValues(msgs)).toEqual([2, 1])
    })

    it('skips a listed file matching an excluded path regex', async () => {
      const root = makeTree()
      const msgs = await runListed(
        root,
        [{ path: `${basename(root)}/level1`, name: 'root_valid.dcm' }],
        defaultFilters({ excludedPathRegexes: [/root_valid/] }),
      )
      expect(fileNames(msgs)).toEqual([])
      expect(errorMessages(msgs)).toEqual([])
    })

    it('reports a listed file that no longer exists as a scan error', async () => {
      const root = makeTree()
      const msgs = await runListed(root, [
        { path: `${basename(root)}/level1`, name: 'gone.dcm' },
      ])
      const errors = errorMessages(msgs)
      expect(errors).toHaveLength(1)
      expect(errors[0].errors?.[0]).toBe(
        'Unable to read file (filesystem error): ENOENT',
      )
      expect(errors[0].fileInfo).toMatchObject({
        path: `${basename(root)}/level1`,
        name: 'gone.dcm',
      })
      expect(msgs.at(-1)).toEqual({ response: 'done' })
    })

    it('rejects a listed entry that names a directory rather than feeding it', async () => {
      const root = makeTree()
      const msgs = await runListed(
        root,
        [{ path: basename(root), name: 'level1' }],
        defaultFilters({ noDicomSignatureCheck: true }),
      )
      expect(fileNames(msgs)).toEqual([])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [NOT_A_FILE_ERROR],
      ])
      expect(countValues(msgs)).toEqual([1, 0])
    })

    it('fails the scan when the list is empty', async () => {
      const msgs = await runListed(makeTree(), [])
      expect(msgs).toEqual([
        {
          response: 'error',
          error: 'Directory scan failed: inputPaths is empty',
        },
      ])
    })

    it('fails the scan rather than hanging on a malformed list', async () => {
      const msgs = await runListed(makeTree(), [null as unknown as TInputPath])
      expect(msgs).toHaveLength(1)
      expect(msgs[0]).toMatchObject({ response: 'error' })
    })

    it('feeds a file listed twice once', async () => {
      const root = makeTree()
      const entry = {
        path: `${basename(root)}/level1`,
        name: 'root_valid.dcm',
      }
      const msgs = await runListed(root, [entry, { ...entry }])
      expect(fileNames(msgs)).toEqual(['root_valid.dcm'])
      expect(countValues(msgs)).toEqual([1])
    })

    it('keeps a valid entry whose joined path matches an invalid one', async () => {
      const root = makeTree()
      const msgs = await runListed(root, [
        { path: `${basename(root)}/level1`, name: 'root_valid.dcm' },
        { path: basename(root), name: 'level1/root_valid.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['root_valid.dcm'])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [UNLOCATED_INPUT_ERROR],
      ])
    })

    it('rejects a Windows separator or drive prefix inside a component', () => {
      for (const [segments, name] of [
        [['a\\b'], 'x.dcm'],
        [[], 'b\\x.dcm'],
        [[], 'c:x.dcm'],
        [['c:'], 'x.dcm'],
      ] as const) {
        expect(relativeNodePath(segments, name, win32)).toBeUndefined()
      }
      expect(relativeNodePath(['a', 'b'], 'x.dcm', win32)).toBe('a\\b\\x.dcm')
      expect(relativeNodePath(['a\\b'], 'x.dcm', posix)).toBe('a\\b/x.dcm')
    })

    it('rejects an entry outside the scan root rather than resolving it', async () => {
      const root = makeTree()
      const msgs = await runListed(root, [
        { path: 'other-root/level1', name: 'root_valid.dcm' },
        { path: `${basename(root)}/../..`, name: 'root_valid.dcm' },
        { path: basename(root), name: '..' },
      ])
      expect(fileNames(msgs)).toEqual([])
      const errors = errorMessages(msgs)
      expect(errors).toHaveLength(3)
      for (const e of errors) {
        expect(e.errors).toEqual([UNLOCATED_INPUT_ERROR])
        expect(e.fileInfo.kind).toBe('unlocated')
      }
    })
    it('rejects a miscased entry where realpath keeps the listed case, as on Linux', async () => {
      const root = makeTree()
      const realRoot = await realRealpath(root)
      // Linux realpath(3) on a case-insensitive mount resolves a miscased path
      // as given. Never touches the disk, so the host's case rules don't matter.
      realpathMock.mockImplementation((async (target: string) =>
        target.startsWith(root)
          ? realRoot + target.slice(root.length)
          : realRealpath(target)) as typeof realRealpath)
      const msgs = await runListed(root, [
        { path: `${basename(root)}/level1`, name: 'ROOT_VALID.dcm' },
        { path: `${basename(root)}/LEVEL1`, name: 'root_valid.dcm' },
        { path: `${basename(root)}/level1`, name: 'root_valid.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['root_valid.dcm'])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [UNLOCATED_INPUT_ERROR],
        [UNLOCATED_INPUT_ERROR],
      ])
    })

    it('fails the run when the root cannot be listed, as a walk does', async () => {
      const root = makeTree()
      readdirMock.mockImplementation(((target: string, options: unknown) =>
        target === root
          ? Promise.reject(
              Object.assign(new Error('EACCES'), { code: 'EACCES' }),
            )
          : realReaddir(target, options as never)) as typeof realReaddir)
      const msgs = await runListed(root, [
        { path: `${basename(root)}/level1`, name: 'root_valid.dcm' },
      ])
      expect(fileNames(msgs)).toEqual([])
      expect(msgs.at(-1)).toMatchObject({ response: 'error' })
      expect(msgs.filter((m) => m.response === 'error')).toHaveLength(1)
    })

    it('rejects a listed entry reached through a symlink, which a walk skips', async () => {
      const root = makeTree()
      const outside = mkdtempSync(join(tmpdir(), 'scancore-outside-'))
      trees.push(outside)
      writeDicom(join(outside, 'secret.dcm'))
      symlinkSync(join(outside, 'secret.dcm'), join(root, 'level1', 'link.dcm'))
      symlinkSync(outside, join(root, 'linked'))
      const msgs = await runListed(root, [
        { path: `${basename(root)}/level1`, name: 'link.dcm' },
        { path: `${basename(root)}/linked`, name: 'secret.dcm' },
      ])
      expect(fileNames(msgs)).toEqual([])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [UNLOCATED_INPUT_ERROR],
        [UNLOCATED_INPUT_ERROR],
      ])
      expect(countValues(msgs)).toEqual([2, 1, 0])
    })
  })

  describe('directory handles', () => {
    function makeTree() {
      const series = new FakeDirHandle('series', [
        new FakeFileHandle('a.dcm', dicomFile('a.dcm')),
        new FakeFileHandle('b.dcm', dicomFile('b.dcm')),
      ])
      const root = new FakeDirHandle('root', [series])
      return { root, series }
    }

    async function runListed(root: FakeDirHandle, inputPaths: TInputPath[]) {
      const { msgs, emit } = collector()
      await scanListedHandles(
        root as unknown as FileSystemDirectoryHandle,
        inputPaths,
        ctx(emit),
      )
      return msgs
    }

    it('reports a listed file with the fileInfo a walk reports', async () => {
      const { root } = makeTree()
      const walked = collector()
      await scanDirectory(
        root as unknown as FileSystemDirectoryHandle,
        ctx(walked.emit),
      )
      const listed = await runListed(root, [
        { path: 'root/series', name: 'b.dcm' },
      ])
      const fromWalk = fileMsgs(walked.msgs).filter(
        (m) => m.fileInfo.name === 'b.dcm',
      )
      expect(fromWalk).toHaveLength(1)
      expect(fileMsgs(listed)).toEqual(fromWalk)
    })

    it('resolves a directory shared by several listed files once', async () => {
      const { root } = makeTree()
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
        { path: 'root/series', name: 'b.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm'])
      expect(root.dirLookups).toBe(1)
    })

    it('rejects an entry a case-insensitive volume resolves under another spelling', async () => {
      const { root, series } = makeTree()
      root.matchCase = false
      series.matchCase = false
      const msgs = await runListed(root, [
        { path: 'root/SERIES', name: 'a.dcm' },
        { path: 'root/series', name: 'A.dcm' },
        { path: 'root/series', name: 'b.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['b.dcm'])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [UNLOCATED_INPUT_ERROR],
        [UNLOCATED_INPUT_ERROR],
      ])
      expect(countValues(msgs)).toEqual([3, 2, 1])
    })

    it('retries a directory lookup, file lookup and listing that fail once', async () => {
      const { root, series } = makeTree()
      root.failLookups = 1
      series.failListings = 1
      series.failFileLookups = 1
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
        { path: 'root/series', name: 'b.dcm' },
      ])
      expect(fileNames(msgs)).toEqual(['a.dcm', 'b.dcm'])
      expect(errorMessages(msgs)).toEqual([])
      expect(requestedDelays()).toEqual([
        LIST_RETRY_DELAYS_MS[0],
        LIST_RETRY_DELAYS_MS[0],
        LIST_RETRY_DELAYS_MS[0],
      ])
    })

    it('fails the run when the root cannot be listed, as a walk does', async () => {
      const { root } = makeTree()
      root.failListings = Infinity
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
      ])
      expect(msgs).toEqual([
        { response: 'count', totalDiscovered: 1 },
        { response: 'error', error: 'Directory scan failed: busy' },
      ])
    })

    it('reports a directory lookup that never succeeds as a read error, once', async () => {
      const { root } = makeTree()
      root.failLookups = Infinity
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
        { path: 'root/series', name: 'b.dcm' },
      ])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        ['Unable to read file (filesystem error): NotReadableError'],
        ['Unable to read file (filesystem error): NotReadableError'],
      ])
      expect(requestedDelays()).toEqual(LIST_RETRY_DELAYS_MS)
    })

    it('fails every file under a directory that never lists, once', async () => {
      const { root, series } = makeTree()
      series.failListings = Infinity
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
        { path: 'root/series', name: 'b.dcm' },
      ])
      expect(fileNames(msgs)).toEqual([])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        ['Unable to list directory (filesystem error): NotReadableError'],
        ['Unable to list directory (filesystem error): NotReadableError'],
      ])
      expect(requestedDelays()).toEqual(LIST_RETRY_DELAYS_MS)
    })

    it('reports a file lookup that never succeeds as a read error', async () => {
      const { root, series } = makeTree()
      series.failFileLookups = Infinity
      const msgs = await runListed(root, [
        { path: 'root/series', name: 'a.dcm' },
      ])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        ['Unable to read file (filesystem error): NotReadableError'],
      ])
    })

    it('reports a listed file under a missing directory as a scan error', async () => {
      const { root } = makeTree()
      const msgs = await runListed(root, [
        { path: 'root/gone', name: 'a.dcm' },
        { path: 'root/series', name: 'gone.dcm' },
      ])
      const errors = errorMessages(msgs)
      expect(errors.map((e) => e.errors)).toEqual([
        ['Unable to read file (filesystem error): NotFoundError'],
        ['Unable to read file (filesystem error): NotFoundError'],
      ])
      expect(errors.map((e) => e.fileInfo.kind)).toEqual([
        'unlocated',
        'unlocated',
      ])
      expect(countValues(msgs)).toEqual([2, 1, 0])
      expect(requestedDelays()).toEqual([])
    })

    it('fails a directory name the API rejects without retrying', async () => {
      const { root } = makeTree()
      root.getDirectoryHandle = async () => {
        throw new TypeError('Name is not allowed.')
      }
      const msgs = await runListed(root, [{ path: 'root/a\\b', name: 'a.dcm' }])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        ['Unable to read file (filesystem error): TypeError'],
      ])
      expect(requestedDelays()).toEqual([])
    })
  })

  describe('s3 keys', () => {
    beforeEach(() => {
      s3Send.mockReset()
      s3Destroy.mockReset()
      s3ClientConfigs.length = 0
    })

    const bucketOptions = {
      bucketName: 'bucket',
      region: 'us-east-1',
      prefix: 'study/',
    } as unknown as TS3BucketOptions
    const listedKey = { path: 'study/a.dcm', name: 'study/a.dcm' }

    async function runListed(
      inputPaths: TInputPath[],
      requestCredentials = async (): Promise<TS3Credentials | undefined> =>
        undefined,
    ) {
      const { msgs, emit } = collector()
      await scanListedS3Keys(
        bucketOptions,
        inputPaths,
        ctx(emit),
        requestCredentials,
      )
      return msgs
    }

    // The first send is the bucket probe; the rest look up one key each.
    function listing(...pages: unknown[]) {
      s3Send.mockResolvedValueOnce({})
      for (const page of pages) s3Send.mockResolvedValueOnce(page)
    }

    it('takes the size from a listing and reports the key as a full scan does', async () => {
      listing({ Contents: [{ Key: 'study/a.dcm', Size: 5000 }] })
      const msgs = await runListed([listedKey])
      expect(fileMsgs(msgs)).toEqual([
        {
          response: 'file',
          fileInfo: {
            size: 5000,
            name: 'study/a.dcm',
            path: 'study/a.dcm',
            objectKey: 'study/a.dcm',
            kind: 's3',
          },
          previousFileInfo: undefined,
        },
      ])
      expect(s3Send.mock.calls.map(([command]) => command.input)).toEqual([
        { Bucket: 'bucket', Prefix: 'study/', MaxKeys: 1 },
        { Bucket: 'bucket', Prefix: 'study/a.dcm', MaxKeys: 1 },
      ])
    })

    it('shares one client while the credentials hold and destroys it after the scan', async () => {
      listing(
        { Contents: [{ Key: 'study/a.dcm', Size: 5000 }] },
        { Contents: [{ Key: 'study/b.dcm', Size: 5000 }] },
      )
      // A fresh copy per request, as the main thread sends.
      const requestCredentials = vi.fn(async () => ({
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      }))
      await runListed(
        [listedKey, { path: 'study/b.dcm', name: 'study/b.dcm' }],
        requestCredentials,
      )
      expect(requestCredentials).toHaveBeenCalledTimes(3)
      expect(s3ClientConfigs).toHaveLength(1)
      expect(s3Destroy).toHaveBeenCalledTimes(1)
    })

    it('replaces the client when the credentials change', async () => {
      listing({ Contents: [{ Key: 'study/a.dcm', Size: 5000 }] })
      let issued = 0
      await runListed([listedKey], async () => ({
        accessKeyId: `key-${++issued}`,
        secretAccessKey: 'secret',
      }))
      expect(
        s3ClientConfigs.map(
          (c) => (c.credentials as TS3Credentials).accessKeyId,
        ),
      ).toEqual(['key-1', 'key-2'])
      expect(s3Destroy).toHaveBeenCalledTimes(2)
    })

    it('fails the run when credentials cannot be fetched', async () => {
      const msgs = await runListed([listedKey], async () => {
        throw new Error('provider failed')
      })
      expect(msgs.at(-1)).toEqual({
        response: 'error',
        error: 'S3 bucket scan failed: provider failed',
      })
      expect(s3Send).not.toHaveBeenCalled()
    })

    it('reports a key the listing does not return as a scan error', async () => {
      listing(
        { Contents: [{ Key: 'study/a.dcm.bak', Size: 10 }] },
        { Contents: [] },
        { Contents: [{ Key: 'study/c.dcm' }] },
      )
      const msgs = await runListed([
        listedKey,
        { path: 'study/b.dcm', name: 'study/b.dcm' },
        { path: 'study/c.dcm', name: 'study/c.dcm' },
      ])
      expect(fileMsgs(msgs)).toEqual([])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [MISSING_KEY_ERROR],
        [MISSING_KEY_ERROR],
        [MISSING_KEY_ERROR],
      ])
      expect(countValues(msgs)).toEqual([3, 2, 1, 0])
    })

    it('reports a key whose listing fails as a scan error', async () => {
      listing()
      s3Send.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDenied' }),
      )
      const errors = errorMessages(await runListed([listedKey]))
      expect(errors.map((e) => e.errors)).toEqual([
        ['Unable to read file (filesystem error): AccessDenied'],
      ])
    })

    it('fails the run when the bucket cannot be listed, as a full scan does', async () => {
      s3Send.mockRejectedValueOnce(new Error('expired credentials'))
      const msgs = await runListed([listedKey])
      expect(msgs).toEqual([
        { response: 'count', totalDiscovered: 1 },
        {
          response: 'error',
          error: 'S3 bucket scan failed: expired credentials',
        },
      ])
      expect(s3Destroy).toHaveBeenCalledTimes(1)
    })

    it('reports a failure to load the S3 client as a scan error', async () => {
      loadS3Client.mockRejectedValueOnce(new Error('chunk failed to load'))
      const msgs = await runListed([listedKey])
      expect(msgs).toEqual([
        { response: 'count', totalDiscovered: 1 },
        {
          response: 'error',
          error: 'S3 bucket scan failed: chunk failed to load',
        },
      ])
    })

    it('rejects a key outside the prefix or not in listing form without a lookup', async () => {
      listing()
      const msgs = await runListed([
        { path: 'other/a.dcm', name: 'other/a.dcm' },
        { path: 'study', name: 'a.dcm' },
      ])
      expect(errorMessages(msgs).map((e) => e.errors)).toEqual([
        [UNLOCATED_INPUT_ERROR],
        [UNLOCATED_INPUT_ERROR],
      ])
      expect(s3Send).toHaveBeenCalledTimes(1)
    })
  })

  it('is what the scan handler runs when a request carries inputPaths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scancore-listed-handler-'))
    trees.push(root)
    writeDicom(join(root, 'a.dcm'))
    writeDicom(join(root, 'b.dcm'))
    const { msgs, emit } = collector()
    const close = vi.fn()
    const { handleMessage } = createScanHandler({ emit, close })
    handleMessage({
      data: {
        request: 'scan',
        path: root,
        inputPaths: [{ path: basename(root), name: 'b.dcm' }],
      },
    } as MessageEvent)
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(fileNames(msgs)).toEqual(['b.dcm'])
  })
})
