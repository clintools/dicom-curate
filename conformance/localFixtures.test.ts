import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseConformanceLocalPathEnv,
  resolveLocalConformanceCases,
} from './localFixtures'

const envKeys = [
  'CONFORMANCE_LOCAL_PATH',
  'CONFORMANCE_LOCAL_BASELINE_DIR',
] as const

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const k of envKeys) {
    saved[k] = process.env[k]
  }
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

describe('localFixtures', () => {
  const saved = saveEnv()
  const tempDirs: string[] = []

  afterEach(() => {
    restoreEnv(saved)
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parseConformanceLocalPathEnv returns empty when unset', () => {
    delete process.env.CONFORMANCE_LOCAL_PATH
    expect(parseConformanceLocalPathEnv()).toEqual([])
  })

  it('discovers a single file and optional baseline path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-local-fix-'))
    tempDirs.push(root)
    const dcm = join(root, 'sample.dcm')
    writeFileSync(dcm, 'DICM')
    const baselineDir = join(root, 'baselines')
    mkdirSync(baselineDir)

    process.env.CONFORMANCE_LOCAL_PATH = dcm
    process.env.CONFORMANCE_LOCAL_BASELINE_DIR = baselineDir

    const cases = resolveLocalConformanceCases()
    expect(cases).toHaveLength(1)
    expect(cases[0]?.id).toBe('sample')
    expect(cases[0]?.dicomPath).toBe(dcm)
    expect(cases[0]?.baselinePath).toBe(
      join(baselineDir, 'sample.dciodvfy-baseline.json'),
    )
  })

  it('discovers all .dcm files under a directory recursively', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-local-dir-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'a.dcm'), 'x')
    writeFileSync(join(root, 'nested', 'b.dcm'), 'y')
    writeFileSync(join(root, 'readme.txt'), 'z')

    process.env.CONFORMANCE_LOCAL_PATH = root
    delete process.env.CONFORMANCE_LOCAL_BASELINE_DIR

    const cases = resolveLocalConformanceCases()
    expect(cases.map((c) => c.id).sort()).toEqual(['a', 'nested--b'])
  })

  it('prefixes fixture ids when multiple roots are configured', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'dc-local-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'dc-local-b-'))
    tempDirs.push(rootA, rootB)
    writeFileSync(join(rootA, 'dup.dcm'), 'a')
    writeFileSync(join(rootB, 'dup.dcm'), 'b')
    const baselineDir = join(rootA, 'baselines')
    mkdirSync(baselineDir)

    process.env.CONFORMANCE_LOCAL_PATH = `${rootA}${delimiter}${rootB}`
    process.env.CONFORMANCE_LOCAL_BASELINE_DIR = baselineDir

    const cases = resolveLocalConformanceCases()
    expect(cases.map((c) => c.id).sort()).toEqual([
      `${basename(rootA)}--dup`,
      `${basename(rootB)}--dup`,
    ])
  })
})
