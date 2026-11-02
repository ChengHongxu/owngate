import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    // Run the DB worker from TS source via tsx so tests don't depend on a build step
    env: {
      WEBRIDGE_DB_WORKER_PATH: resolve(__dirname, 'src/worker.ts'),
    },
    testTimeout: 15000,
  },
});
