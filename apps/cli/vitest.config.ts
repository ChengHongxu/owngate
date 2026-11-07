import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Process suites spawn CLI instances and initialize native crypto / PGlite.
    // Keep files serial on small runners; 5s measures contention, not correctness.
    fileParallelism: false,
    testTimeout: 15_000,
    passWithNoTests: true,
  },
});
