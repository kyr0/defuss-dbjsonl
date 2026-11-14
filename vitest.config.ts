import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/*.test.ts'], testTimeout: 20000,
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/types.ts'],
    reporter: ['text', 'json-summary', 'html'], reportsDirectory: 'output/coverage',
    thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 } },
} });
