import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'path';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import {
  createClarityBuildConfig,
  type ClarityBuildEnv,
} from './src/shared/analytics/clarityConfig';

const clarityBuildEnvKeys = ['CLARITY_PROJECT_ID', 'NODE_ENV'] as const;
const REACT_SCAN_ENABLED_ENV = 'ANTIGRAVITY_ENABLE_REACT_SCAN';
const REACT_SCAN_ENTRY = '/src/modules/app-shell/diagnostics/react-scan.ts';

/**
 * React Scan has to be an independently injected development entry. Importing
 * it from the renderer would make the diagnostic available to every build
 * before a runtime condition could exclude the production bundle.
 */
function createReactScanPlugin(): Plugin {
  return {
    name: 'antigravity-react-scan',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: REACT_SCAN_ENTRY,
          },
          injectTo: 'body-prepend',
        },
      ],
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || env.SENTRY_AUTH_TOKEN;
  const shouldEnableSentry =
    mode === 'production' &&
    Boolean(sentryAuthToken) &&
    process.env.AGM_DISABLE_SENTRY_UPLOAD !== '1';
  const shouldEnableReactScan =
    mode === 'development' &&
    (process.env[REACT_SCAN_ENABLED_ENV] ?? env[REACT_SCAN_ENABLED_ENV]) === '1';
  const clarityBuildEnv = Object.fromEntries(
    clarityBuildEnvKeys.map((key) => [key, process.env[key] || env[key] || '']),
  ) as ClarityBuildEnv;
  clarityBuildEnv.NODE_ENV = clarityBuildEnv.NODE_ENV || mode;

  return {
    // Keep the development listener reachable when IPv6 loopback is unavailable.
    server: { host: '127.0.0.1' },
    plugins: [
      ...(shouldEnableSentry
        ? [
            sentryVitePlugin({
              org: process.env.SENTRY_ORG || env.SENTRY_ORG,
              project: process.env.SENTRY_PROJECT || env.SENTRY_PROJECT,
              authToken: sentryAuthToken,
              release: {
                name: `${process.env.npm_package_name}@${process.env.npm_package_version}`,
              },
              // Electron loads files from app://, so we need to normalize paths for Source Map matching
              sourcemaps: {
                // Rewrite the source paths to strip the Electron app:// protocol
                rewriteSources: (source) => {
                  // Transform: app:///.vite/renderer/main_window/assets/index.js
                  // Into:      ~/.vite/renderer/main_window/assets/index.js
                  return source.replace(/^app:\/\/\//, '~/');
                },
              },
            }),
          ]
        : []),
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),
      tailwindcss(),
      ...(mode === 'production' ? [] : [codeInspectorPlugin({ bundler: 'vite' })]),
      ...(shouldEnableReactScan ? [createReactScanPlugin()] : []),
      react({
        babel: {
          plugins: ['babel-plugin-react-compiler'],
        },
      }),
    ],
    optimizeDeps: {
      entries: ['index.html'],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || env.SENTRY_DSN),
      CLARITY_BUILD_CONFIG: JSON.stringify(createClarityBuildConfig(clarityBuildEnv)),
    },
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@': path.resolve(process.cwd(), './src'),
      },
    },
  };
});
