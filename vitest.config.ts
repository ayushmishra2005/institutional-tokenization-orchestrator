import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one PostgreSQL/Redis/Anvil stack, so suites run serially
    // and concurrency assertions are not perturbed by unrelated parallel work.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
