import { defineConfig } from 'vitest/config';

/**
 * Live tests against a real Supabase project (not part of `npm test`). They need the network and
 * three confirmed throwaway users; see tests/live/README.md.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: ['default'],
  },
});
