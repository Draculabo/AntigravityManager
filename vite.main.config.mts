import { defineConfig } from 'vite';
import path from 'path';

// https://vitejs.dev/config
export default defineConfig({
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
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ['better-sqlite3', 'keytar'],
    },
  },
});
