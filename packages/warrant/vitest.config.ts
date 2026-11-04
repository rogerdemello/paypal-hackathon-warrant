import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Property tests run thousands of cases (for example every byte position of a serialized ledger). Under coverage on a
    // loaded CI runner that can exceed vitest's 5 s default without anything being wrong.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // docs/testing.md: at least 90% line coverage on the warrant package. The gate fails `pnpm test` if it drops.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
