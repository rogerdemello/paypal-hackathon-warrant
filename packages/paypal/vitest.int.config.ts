import { defineConfig } from 'vitest/config';

/** Integration tests against the real PayPal sandbox (`pnpm test:int`). They are not part of `pnpm test`. */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // PayPal's sandbox rate-limits; one file at a time, tests in order.
    fileParallelism: false,
  },
});
