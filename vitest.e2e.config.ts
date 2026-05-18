import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    // Use the built ESM entry
    alias: {
      'dicom-curate': resolve(repoRoot, 'dist/esm/index.js'),
    },
  },
  test: {
    pool: 'forks',
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
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
})
