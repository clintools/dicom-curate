/**
 * Public dirty corpus (conformance/public-cases.json). Catalog and baseline
 * presence tests always run; fetch + dciodvfy tests require
 * RUN_PUBLIC_CONFORMANCE (any value except 0/false) and network on first
 * run. Cases are prefetched in a beforeAll, then run the shared differential
 * suite. See README.md — "dciodvfy.public.test.ts" and baselines/public/.
 */

import { existsSync } from 'node:fs'
import { caseCachePath, fetchPublicCaseToCache } from 'dicom-synth'
import { beforeAll, describe, expect, it } from 'vitest'
import { registerDifferentialConformanceTests } from './differentialSuite'
import { publicBaselinePath } from './helpers'
import { loadPublicCases } from './publicCases'

const cases = loadPublicCases()
const runPublic = !['', '0', 'false'].includes(
  (process.env.RUN_PUBLIC_CONFORMANCE ?? '').trim().toLowerCase(),
)

const ALLOWED_CASE_KEYS = new Set([
  'id',
  'violation_class',
  'notes',
  'source',
  'sha256',
  'dciodvfy_skip',
  'curate_skip',
])

describe('public case catalog', () => {
  it('entries are well-formed with unique ids', () => {
    expect(cases.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const c of cases) {
      expect(c.id, 'case id').toBeTruthy()
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false)
      ids.add(c.id)
      expect(c.sha256, `${c.id} sha256`).toMatch(/^[0-9a-f]{64}$/)
      expect(c.source.kind, `${c.id} source kind`).toBe('url')
      if (c.source.kind === 'url') {
        expect(c.source.url, `${c.id} url`).toMatch(/^https:\/\//)
      }
      expect(c.violation_class, `${c.id} violation_class`).toBeTruthy()
      // The JSON load is unvalidated: a typo'd skip flag would coerce to false.
      for (const key of Object.keys(c)) {
        expect(ALLOWED_CASE_KEYS.has(key), `${c.id} unknown key "${key}"`).toBe(
          true,
        )
      }
      if (c.dciodvfy_skip !== undefined) {
        expect(typeof c.dciodvfy_skip, `${c.id} dciodvfy_skip`).toBe('boolean')
      }
      if (c.curate_skip !== undefined) {
        expect(typeof c.curate_skip, `${c.id} curate_skip`).toBe('boolean')
      }
    }
  })

  it('every dciodvfy-capable case has a committed baseline', () => {
    for (const c of cases) {
      if (c.dciodvfy_skip) continue
      expect(
        existsSync(publicBaselinePath(c.id)),
        `missing baseline for ${c.id} — run pnpm update:conformance-baselines`,
      ).toBe(true)
    }
  })
})

describe('dciodvfy public fixtures', () => {
  beforeAll(async () => {
    if (!runPublic) return
    await Promise.all(cases.map((c) => fetchPublicCaseToCache(c)))
  }, 120_000)

  for (const c of cases.filter((c) => c.dciodvfy_skip)) {
    it.skipIf(!runPublic)(
      `${c.id}: fetch verifies pinned sha256 (dciodvfy_skip)`,
      async () => {
        const sourcePath = await fetchPublicCaseToCache(c)
        expect(existsSync(sourcePath)).toBe(true)
      },
    )
  }

  registerDifferentialConformanceTests(
    cases
      .filter((c) => !c.dciodvfy_skip)
      .map((c) => ({
        id: c.id,
        dicomPath: caseCachePath(c.sha256),
        baselinePath: publicBaselinePath(c.id),
        skip: !runPublic,
        expectCurateRejection: c.curate_skip,
      })),
    'dc-public',
  )
})
