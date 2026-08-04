import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  outputDir: './test-results/playwright-performance',
  reporter: 'list',
  testDir: './src/tests/performance',
  timeout: 120_000,
  workers: 1,
});
