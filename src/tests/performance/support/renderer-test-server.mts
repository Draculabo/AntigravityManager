import path from 'node:path';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export function createRendererTestServer(cacheKey: string, plugins: Plugin[] = []) {
  const root = process.cwd();
  const support = path.join(root, 'src/tests/performance/support');
  return createServer({
    configFile: false,
    root: support,
    logLevel: 'error',
    cacheDir: path.join(root, 'node_modules/.vite/renderer-profile', cacheKey),
    plugins: [
      react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
      tailwindcss(),
      ...plugins,
    ],
    resolve: {
      alias: [
        { find: '@/ipc/manager', replacement: path.join(support, 'renderer-updates-ipc.ts') },
        { find: '@', replacement: path.join(root, 'src') },
      ],
    },
    optimizeDeps: { entries: ['renderer-updates.html'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
}
