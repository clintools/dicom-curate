import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    server: {
      deps: {
        inline: ['@noble/hashes'],
      },
    },
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
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
      // Thresholds are intentionally omitted: worker entry files above are
      // covered out-of-band; set per-file thresholds here once v8 attributes
      // worker_threads execution or those files are tested in-process.
    },
  },
})
