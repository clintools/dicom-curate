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
        // Worker entry points are excluded from coverage totals because Vitest v8
        // does not attribute child-thread execution to these files; they are
        // exercised via dist/esm bundles in scanDirectoryWorker.test.ts and
        // applyMappingsWorker.test.ts (see workerTestHelpers.ts). Do not treat
        // headline coverage % as complete without those integration tests.
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
