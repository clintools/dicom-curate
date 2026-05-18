import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDicomDir } from '../testutils/dicomFixtures'
import {
  writeFakeDicomSignatureFile,
  writeMinimalDicomFile,
  writeNonDicomFile,
} from '../testutils/minimalDicom'
import { collectScanMessages } from '../testutils/workerTestHelpers'

function makeScanTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'scan-worker-test-'))
  const nested = join(root, 'level1', 'nested')
  mkdirSync(nested, { recursive: true })
  writeMinimalDicomFile(join(root, 'level1', 'root_valid.dcm'))
  writeMinimalDicomFile(join(nested, 'nested_valid.dcm'))
  writeNonDicomFile(join(root, 'readme.txt'))
  writeNonDicomFile(join(root, 'tiny.bin'), 'x')
  writeFakeDicomSignatureFile(join(root, 'fake.dcm'))
  return root
}

describe('scanDirectoryWorker (Node path scan)', () => {
  const trees: string[] = []

  afterEach(() => {
    for (const t of trees.splice(0)) {
      rmSync(t, { recursive: true, force: true })
    }
  })

  it('discovers valid DICOM files in nested directories', async () => {
    const root = makeScanTree()
    trees.push(root)

    const { files, done, error } = await collectScanMessages(root)
    expect(error).toBeUndefined()
    expect(done).toBe(true)

    const names = files
      .filter((m) => m.response === 'file')
      .map((m) => m.fileInfo.name)
      .sort()
    expect(names).toEqual(['nested_valid.dcm', 'root_valid.dcm'])
  })

  it('reports anomalies for non-DICOM and invalid signature files', async () => {
    const root = makeScanTree()
    trees.push(root)

    const { anomalies } = await collectScanMessages(root)
    const texts = anomalies.flatMap((m) =>
      m.response === 'scanAnomalies' ? m.anomalies : [],
    )
    expect(texts.some((t) => t.includes('DICOM signature'))).toBe(true)
    expect(texts.some((t) => t.includes('very small'))).toBe(true)
  })

  it('skips default excluded filetypes with anomalies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-excl-'))
    trees.push(root)
    writeMinimalDicomFile(join(root, 'good.dcm'))
    writeFileSync(join(root, 'DICOMDIR'), Buffer.alloc(200))

    const { files, anomalies } = await collectScanMessages(root)
    expect(files.map((m) => m.fileInfo.name)).toEqual(['good.dcm'])
    expect(
      anomalies.some(
        (m) =>
          m.response === 'scanAnomalies' &&
          m.anomalies.some((a) => a.toLowerCase().includes('dicomdir')),
      ),
    ).toBe(true)
  })

  it('handles unicode path segments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-unicode-'))
    trees.push(root)
    const sub = join(root, '患者データ')
    mkdirSync(sub, { recursive: true })
    writeMinimalDicomFile(join(sub, '検査.dcm'))

    const { files, done } = await collectScanMessages(root)
    expect(done).toBe(true)
    expect(files.some((m) => m.fileInfo.name === '検査.dcm')).toBe(true)
  })

  it('traverses directories whose names end with a dot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-dotdir-'))
    trees.push(root)
    const dotted = join(root, 'study.')
    mkdirSync(dotted, { recursive: true })
    writeMinimalDicomFile(join(dotted, 'inside.dcm'))

    const { files, done } = await collectScanMessages(root)
    expect(done).toBe(true)
    expect(files.some((m) => m.fileInfo.name === 'inside.dcm')).toBe(true)
  })

  it('discovers many files and final count matches emitted files', async () => {
    const root = createTestDicomDir(80, { subdirName: 'BULK' })
    trees.push(root)

    const { files, counts, done } = await collectScanMessages(
      root,
      undefined,
      60_000,
    )
    expect(done).toBe(true)
    expect(files.length).toBe(80)
    if (counts.length > 0) {
      expect(counts[counts.length - 1]).toBe(80)
    }
  })

  it('uses a deep path without failing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-long-'))
    trees.push(root)
    let dir = root
    for (let i = 0; i < 12; i++) {
      dir = join(dir, `segment${i}`)
      mkdirSync(dir)
    }
    writeMinimalDicomFile(join(dir, 'deep.dcm'))

    const { files, done, error } = await collectScanMessages(root)
    expect(error).toBeUndefined()
    expect(done).toBe(true)
    expect(files.some((m) => m.fileInfo.name === 'deep.dcm')).toBe(true)
  })

  it('passes previousFileInfo from fileInfoIndex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-index-'))
    trees.push(root)
    writeMinimalDicomFile(join(root, 'indexed.dcm'))
    const baseName = root.split('/').pop()!
    const key = `${baseName}/indexed.dcm`

    const { files } = await collectScanMessages(root, {
      fileInfoIndex: {
        [key]: { size: 999, mtime: '2020-01-01T00:00:00.000Z' },
      },
    })
    const fileMsg = files.find((m) => m.fileInfo.name === 'indexed.dcm')
    expect(fileMsg?.previousFileInfo?.size).toBe(999)
    expect(fileMsg?.previousFileInfo?.mtime).toBe('2020-01-01T00:00:00.000Z')
  })
})
