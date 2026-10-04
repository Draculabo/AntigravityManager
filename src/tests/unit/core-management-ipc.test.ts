import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import type { CoreStatus } from '@/core/core-service';
import { ManagementClient } from '@/core/management/client';
import { getProfileFingerprint } from '@/core/management/handshake';

const servers: ManagementServer[] = [];
const directories: string[] = [];

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-core-ipc-'));
  directories.push(directory);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agm-test-${path.basename(directory)}`;
  }
  return path.join(directory, 'core.sock');
}

async function request(
  socketPath: string,
  method: string,
  route: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const client = http.request({ socketPath, path: route, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });
    client.once('error', reject);
    client.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('core management IPC', () => {
  it('returns a safe strict handshake and rejects stale desktop epochs before side effects', async () => {
    const socketPath = await endpoint();
    const shutdown = vi.fn(async () => undefined);
    const options = {
      endpoint: socketPath,
      getStatus: (): CoreStatus => ({
        state: 'running',
        pid: 123,
        gateway: { running: false, port: null },
      }),
      shutdown,
      onShutdownError: vi.fn(),
    };
    const first = new ManagementServer(options);
    servers.push(first);
    await first.start();
    const handshake = await new ManagementClient(socketPath).handshake();
    expect(handshake).toEqual({
      version: 1,
      compatibility: 1,
      kind: 'core',
      pid: 123,
      epoch: expect.any(String),
      profile: getProfileFingerprint(),
      ready: true,
    });
    const pinned = new ManagementClient(socketPath, undefined, handshake.epoch);
    await first.close();
    const replacement = new ManagementServer(options);
    servers.push(replacement);
    await replacement.start();
    await expect(pinned.shutdown()).rejects.toThrow('HTTP 409');
    expect(shutdown).not.toHaveBeenCalled();
    const fresh = await new ManagementClient(socketPath).handshake();
    expect(fresh.epoch).not.toBe(handshake.epoch);
    replacement.beginShutdown();
    expect((await new ManagementClient(socketPath).handshake()).ready).toBe(false);
  });
  it('serves status and acknowledges shutdown over the local endpoint', async () => {
    const socketPath = await endpoint();
    const status: CoreStatus = {
      state: 'running',
      pid: 123,
      gateway: { running: true, port: 8045 },
    };
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => status,
      shutdown,
      onShutdownError: vi.fn(),
    });
    servers.push(server);
    await server.start();

    expect(await request(socketPath, 'GET', '/v1/status')).toEqual({
      status: 200,
      body: { version: 1, ok: true, status },
    });
    expect(await request(socketPath, 'POST', '/v1/shutdown')).toEqual({
      status: 200,
      body: { version: 1, ok: true, shuttingDown: true },
    });
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it('refuses a second owner of the same endpoint', async () => {
    const socketPath = await endpoint();
    const options = {
      endpoint: socketPath,
      getStatus: (): CoreStatus => ({
        state: 'running',
        pid: 123,
        gateway: { running: false, port: null },
      }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
    };
    const first = new ManagementServer(options);
    const second = new ManagementServer(options);
    servers.push(first);
    await first.start();

    await expect(second.start()).rejects.toThrow();
    expect((await request(socketPath, 'GET', '/v1/status')).status).toBe(200);
  });

  it('reports route-triggered shutdown failure after replying to the client', async () => {
    const socketPath = await endpoint();
    const failure = new Error('shutdown failed');
    const onShutdownError = vi.fn();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {
        throw failure;
      },
      onShutdownError,
    });
    servers.push(server);
    await server.start();

    expect((await request(socketPath, 'POST', '/v1/shutdown')).status).toBe(200);
    await vi.waitFor(() => expect(onShutdownError).toHaveBeenCalledExactlyOnceWith(failure));
  });

  it.skipIf(process.platform === 'win32')(
    'recovers one stale Unix socket without allowing competing owners',
    async () => {
      const socketPath = await endpoint();
      const child = spawn(
        process.execPath,
        [
          '-e',
          'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready\\n"))',
          socketPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        await once(child.stdout, 'data');
      } finally {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }

      const options = {
        endpoint: socketPath,
        getStatus: (): CoreStatus => ({
          state: 'running',
          pid: 123,
          gateway: { running: false, port: null },
        }),
        shutdown: async () => {},
        onShutdownError: vi.fn(),
      };
      const first = new ManagementServer(options);
      const second = new ManagementServer(options);
      const results = await Promise.allSettled([first.start(), second.start()]);
      const owners = [first, second].filter((_, index) => results[index].status === 'fulfilled');
      servers.push(...owners);

      expect(owners).toHaveLength(1);
      expect((await request(socketPath, 'GET', '/v1/status')).status).toBe(200);
      expect(((await fs.stat(socketPath)).mode & 0o777).toString(8)).toBe('600');
      expect(((await fs.stat(path.dirname(socketPath))).mode & 0o777).toString(8)).toBe('700');
    },
  );
});
