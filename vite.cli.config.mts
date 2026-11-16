import path from 'node:path';
import { defineConfig } from 'vite';
import bundledDependencies from './scripts/build/standalone-bundled-dependencies.json';

export default defineConfig({
  plugins: [
    {
      name: 'reject-electron-in-cli',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'electron' || source.startsWith('electron/')) {
          throw new Error(`Electron import is not allowed in the CLI: ${importer}`);
        }
      },
    },
  ],
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  ssr: {
    noExternal: Object.keys(bundledDependencies),
  },
  build: {
    target: 'node22',
    ssr: 'src/cli/main.ts',
    outDir: 'dist/cli',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'main.cjs' } },
  },
});
