/**
 * A/B throughput: head's `curateMany` timed against base's on the same runner,
 * so runner speed cancels out. Defaults to A/A on `dist/esm`; CI points
 * THROUGHPUT_BASE_DIST at a build of the PR's base.
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ValidImageSpec } from 'dicom-synth'
import { ps315SmokeSpec } from '../e2e/helpers'
import type { curateMany } from '../src/index'
import type { OrganizeOptions } from '../src/types'
import {
  integrationOptions,
  integrationSpec,
  runQuietly,
  useWorkspaces,
  writeImages,
} from '../testutils/integrationHarness'
import { VALID_CT_IMAGE } from '../testutils/synthFixtures'

type CurateMany = typeof curateMany

const HEAD_DIST = 'dist/esm'
const BASE_DIST = process.env.THROUGHPUT_BASE_DIST ?? HEAD_DIST
const PAIRS = envNumber('THROUGHPUT_PAIRS', 4)
/** Provisional until calibrated against A/A runs on CI. */
const THRESHOLD_PCT = envNumber('THROUGHPUT_THRESHOLD_PCT', 15)

// Alternating order cancels the run-order bias only over an even number of pairs.
if (!Number.isInteger(PAIRS) || PAIRS % 2 !== 0) {
  throw new Error(`THROUGHPUT_PAIRS must be an even integer, got ${PAIRS}`)
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`)
  }
  return value
}

type Workload = {
  name: string
  count: number
  image: ValidImageSpec
  spec: OrganizeOptions['curationSpec']
}

const WORKLOADS: Workload[] = [
  // Dispatch and worker overhead dominate.
  {
    name: 'small-20k',
    count: 20_000,
    image: VALID_CT_IMAGE,
    spec: integrationSpec(),
  },
  // Per-file parse, PS3.15 de-identification and write dominate.
  {
    name: 'deid-500',
    count: 500,
    image: { ...VALID_CT_IMAGE, targetSizeKb: 1024 },
    spec: ps315SmokeSpec(),
  },
]

async function loadCurateMany(dist: string): Promise<CurateMany> {
  const url = pathToFileURL(resolve(dist, 'index.js')).href
  const mod = await import(/* @vite-ignore */ url)
  return mod.curateMany
}

const BASE_FIRST = ['base', 'head'] as const
const HEAD_FIRST = ['head', 'base'] as const

type Verdict = 'slower' | 'faster' | 'no significant change'

function verdict(changePct: number): Verdict {
  if (changePct > THRESHOLD_PCT) return 'slower'
  if (changePct < -THRESHOLD_PCT) return 'faster'
  return 'no significant change'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

describe('curateMany throughput, head against base', () => {
  const workspace = useWorkspaces()
  let base: CurateMany
  let head: CurateMany

  beforeAll(async () => {
    base = await loadCurateMany(BASE_DIST)
    head = await loadCurateMany(HEAD_DIST)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Throughput, head vs base (±${THRESHOLD_PCT}% allowed)\n\n` +
          '| Workload | Verdict | Head vs base | Base | Head | Head/base per pair |\n' +
          '|---|---|---|---|---|---|\n',
      )
    }
  })

  afterAll(() => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        '\nPer-pair ratio: head time / base time. Below 1 = head faster. ' +
          `Verdict uses the median ratio; outside ±${THRESHOLD_PCT}% fails the check.\n`,
      )
    }
  })

  for (const workload of WORKLOADS) {
    it(`${workload.name}: head is within ±${THRESHOLD_PCT}% of base`, async () => {
      const { inputDir, outputDir } = workspace()
      await writeImages(inputDir, workload.count, workload.image)
      const runDir = join(outputDir, 'run')

      async function timeRun(build: 'base' | 'head'): Promise<number> {
        rmSync(runDir, { recursive: true, force: true })
        mkdirSync(runDir)
        const start = performance.now()
        const { done, errorCount } = await runQuietly(
          integrationOptions(inputDir, runDir, workload.spec, {
            workerCount: 4,
            skipCollectingMappings: true,
          }),
          { base, head }[build],
        )
        const ms = performance.now() - start
        // A run that fails or skips files would otherwise read as fast.
        expect(errorCount, `${build} errors`).toBe(0)
        expect(done.processedFiles, `${build} processed files`).toBe(
          workload.count,
        )
        return ms
      }

      const pairs: { base: number; head: number }[] = []
      for (let pair = 0; pair < PAIRS; pair++) {
        // The second run of a pair inherits the first's page cache and pending
        // writes, so a fixed order would bias one side.
        const order = pair % 2 === 0 ? BASE_FIRST : HEAD_FIRST
        const ms = { base: 0, head: 0 }
        for (const build of order) {
          ms[build] = await timeRun(build)
        }
        pairs.push(ms)
      }

      const ratios = pairs.map((p) => p.head / p.base)
      const changePct = (median(ratios) - 1) * 100
      const result = verdict(changePct)
      const baseMedian = `${median(pairs.map((p) => p.base)).toFixed(0)} ms`
      const headMedian = `${median(pairs.map((p) => p.head)).toFixed(0)} ms`
      const change = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`
      const perPair = ratios.map((r) => r.toFixed(3)).join(', ')

      console.log(
        `${workload.name}: ${result} (head ${change} vs base, threshold ±${THRESHOLD_PCT}%)\n` +
          `  medians: base ${baseMedian}, head ${headMedian}\n` +
          `  head/base per pair (<1 faster, >1 slower): ${perPair}`,
      )
      if (process.env.GITHUB_STEP_SUMMARY) {
        const row = [
          workload.name,
          result[0].toUpperCase() + result.slice(1),
          change,
          baseMedian,
          headMedian,
          perPair,
        ]
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `| ${row.join(' | ')} |\n`,
        )
      }

      expect(
        result,
        `${workload.name}: head is ${Math.abs(changePct).toFixed(1)}% ${result} than base (threshold ±${THRESHOLD_PCT}%)`,
      ).toBe('no significant change')
    })
  }
})
