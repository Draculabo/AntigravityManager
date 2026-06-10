import { defineConfig, loadEnv } from 'vite';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import {
  createOpenTelemetryBuildConfig,
  type OpenTelemetryBuildEnv,
} from './src/shared/observability/openTelemetryConfig';

const mainProcessExternals = [
  'better-sqlite3',
  'keytar',
  '@napi-rs/keyring',
  '@opentelemetry/api',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-node',
];

const openTelemetryBuildEnvKeys = [
  'AGM_OTEL_DEBUG',
  'NODE_ENV',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_METRICS_EXPORTER',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SDK_DISABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_TRACES_EXPORTER',
] as const;

function getOpenTelemetryBuildEnv(mode: string, env: Record<string, string>) {
  return Object.fromEntries(
    openTelemetryBuildEnvKeys.map((key) => {
      const valueFromProcess = process.env[key];
      if (valueFromProcess !== undefined) {
        return [key, valueFromProcess];
      }

      if (mode === 'development') {
        return [key, ''];
      }

      return [key, env[key] || ''];
    }),
  ) as OpenTelemetryBuildEnv;
}

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || env.SENTRY_AUTH_TOKEN;
  const shouldEnableSentry = mode === 'production' && Boolean(sentryAuthToken);
  const openTelemetryBuildEnv = getOpenTelemetryBuildEnv(mode, env);

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
      OPEN_TELEMETRY_BUILD_CONFIG: JSON.stringify(
        createOpenTelemetryBuildConfig(openTelemetryBuildEnv),
      ),
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
        external: mainProcessExternals,
      },
    },
  };
});
