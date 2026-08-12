import { rmSync } from 'node:fs'
import { basename } from 'node:path'
import type { PathQuirk } from 'dicom-synth'
import {
  QUIRK_FIXTURE_FILE_COUNT,
  writeQuirkFixture,
} from '../testutils/synthFixtures'
import { collectScanMessages } from '../testutils/workerTestHelpers'

// On POSIX filesystems every quirk below is legal and must be discovered in
// full. The historical Chrome File System Access API failure on trailing-dot
// directories lived in the separate FileSystemDirectoryHandle path, which
// cannot be driven from a Node worker test.
const quirks: PathQuirk[] = [
  'trailing-dot',
  'unicode',
  'deep-nesting',
  'long-name',
]

function relativeFromRoot(root: string, path: string, name: string): string {
  const prefix = `${basename(root)}/`
  return `${path}/${name}`.slice(prefix.length)
}

describe('scanDirectoryWorker over edge-case directory trees', () => {
  const trees: string[] = []

  afterEach(() => {
    for (const t of trees.splice(0)) {
      rmSync(t, { recursive: true, force: true })
    }
  })

  it.each(
    quirks,
  )('discovers every DICOM file under %s paths', async (quirk) => {
    const { root, relativePaths } = await writeQuirkFixture(quirk)
    trees.push(root)
    expect(relativePaths).toHaveLength(QUIRK_FIXTURE_FILE_COUNT)

    const { files, done, error } = await collectScanMessages(root)
    expect(error).toBeUndefined()
    expect(done).toBe(true)

    const discovered = files
      .map((m) => relativeFromRoot(root, m.fileInfo.path, m.fileInfo.name))
      .sort()
    expect(discovered).toEqual([...relativePaths].sort())
  })
})
