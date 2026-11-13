import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Migration and RLS integration tests boot a pool and apply/verify 37
    // migrations; the 5s default is too tight on a cold database.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
