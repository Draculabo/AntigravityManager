import { defineConfig, loadEnv } from 'vite';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// https://vitejs.dev/config
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
    define: {
      'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || env.SENTRY_DSN),
    },
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), './src'),
        kafkajs: path.resolve(process.cwd(), './src/mocks/empty.ts'),
        mqtt: path.resolve(process.cwd(), './src/mocks/empty.ts'),
        amqplib: path.resolve(process.cwd(), './src/mocks/empty.ts'),
        'amqp-connection-manager': path.resolve(process.cwd(), './src/mocks/empty.ts'),
        nats: path.resolve(process.cwd(), './src/mocks/empty.ts'),
        ioredis: path.resolve(process.cwd(), './src/mocks/empty.ts'),
        '@fastify/static': path.resolve(process.cwd(), './src/mocks/empty.ts'),
        '@fastify/view': path.resolve(process.cwd(), './src/mocks/empty.ts'),
        '@nestjs/microservices': path.resolve(process.cwd(), './src/mocks/nestjs-microservices'),
        '@nestjs/websockets': path.resolve(process.cwd(), './src/mocks/nestjs-websockets'),
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
