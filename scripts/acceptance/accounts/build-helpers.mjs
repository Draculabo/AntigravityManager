import path from 'node:path';
import { Command } from 'commander';
import { build, loadConfigFromFile } from 'vite';
const root = process.cwd();
const options = new Command()
  .option(
    '--output <directory>',
    'Compiled helper output directory',
    'out/account-switch-acceptance/helpers',
  )
  .parse()
  .opts();
const output = path.resolve(root, options.output);
const artifacts = path.join(root, 'scripts/acceptance/accounts');
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  path.join(root, 'vite.core.config.mts'),
);
await build({
  ...loaded.config,
  configFile: false,
  plugins: [],
  logLevel: 'error',
  build: {
    ...loaded.config.build,
    outDir: output,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      ...loaded.config.build.rollupOptions,
      input: path.join(artifacts, 'runtime-entry.ts'),
      output: { format: 'cjs', entryFileNames: 'runtime.cjs' },
    },
  },
});
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: path.join(artifacts, 'renderer-entry.ts'),
      name: 'AccountAcceptance',
      formats: ['iife'],
      fileName: () => 'renderer.js',
    },
  },
});
console.log('Acceptance helper bundles ready');
