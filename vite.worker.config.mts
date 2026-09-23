import path from 'node:path';

import { defineConfig } from 'vite';

// Worker entries are compiled independently by Electron Forge and share the main-process
// output directory. Native SQLite remains external so Electron loads the unpacked ABI-matched
// binary, while Drizzle and the feature repositories are bundled into each worker entry.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), './src'),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
