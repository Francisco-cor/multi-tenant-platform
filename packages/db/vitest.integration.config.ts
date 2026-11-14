import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    // Integration files share one database; cleanup that temporarily disables
    // append-only triggers must not overlap another file's assertions.
    fileParallelism: false,
  },
});
