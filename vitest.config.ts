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
      ],
    },
  },
})
