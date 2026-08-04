import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'dicom-curate': resolve(repoRoot, 'dist/esm/index.js'),
    },
  },
  test: {
    pool: 'forks',
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.integration.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        // Thread wiring only; the logic they delegate to lives in scanCore.ts /
        // applyMappingsCore.ts, which are covered by in-process unit tests.
        // Excluded because Vitest v8 attributes nothing to code running inside a
        // worker_threads child, not because they are untested — the wiring is
        // exercised end-to-end via the dist/esm bundles in
        // scanDirectoryWorker.test.ts / applyMappingsWorker.test.ts (see
        // workerTestHelpers.ts).
        'src/scanDirectoryWorker.ts',
        'src/applyMappingsWorker.ts',
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'e2e/**',
            'conformance/**',
            // Runs in the 'integration' project instead: needs the dist/esm
            // build, so it cannot run in the fast unit pass.
            'src/**/*.integration.test.ts',
          ],
          server: {
            deps: {
              inline: ['@noble/hashes'],
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          hookTimeout: 30_000,
          server: {
            deps: {
              inline: ['@noble/hashes'],
            },
          },
        },
      },
      {
        extends: true,
        test: {
          // Cross-module flows driven through real workers from dist/esm.
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          hookTimeout: 30_000,
          server: {
            deps: {
              inline: ['@noble/hashes'],
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'conformance',
          include: ['conformance/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          server: {
            deps: {
              inline: ['@noble/hashes', 'dcmjs', 'dicom-synth'],
            },
          },
        },
      },
    ],
  },
})
