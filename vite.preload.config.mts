import { defineConfig, loadEnv } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || env.SENTRY_AUTH_TOKEN;
  const shouldEnableSentry = mode === 'production' && Boolean(sentryAuthToken);

  return {
    plugins: shouldEnableSentry
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG || env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT || env.SENTRY_PROJECT,
            authToken: sentryAuthToken,
            release: {
              name: `${process.env.npm_package_name}@${process.env.npm_package_version}`,
            },
          }),
        ]
      : [],
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), './src'),
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ['better-sqlite3', 'keytar'],
      },
    },
  };
});
