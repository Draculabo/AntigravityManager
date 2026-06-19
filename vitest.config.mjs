import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), './src'),
      // Mock native modules that fail to load in test environment
      keytar: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      'better-sqlite3': path.resolve(process.cwd(), './src/mocks/empty.ts'),
      electron: path.resolve(process.cwd(), './src/mocks/electron.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/tests/unit/**/*.test.ts'],
  },
});
