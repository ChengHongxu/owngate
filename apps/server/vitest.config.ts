import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    testTimeout: 30000,
  },
});
