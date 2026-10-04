import fs from 'node:fs/promises';
import net, { type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileLease,
  ProfileOwnershipError,
  probeProfileOwner,
} from '@/core/ownership/profile-lease';

const leases: ProfileLease[] = [];
const servers: Server[] = [];
const directories: string[] = [];

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-lease-'));
  directories.push(directory);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agm-lease-test-${path.basename(directory)}`;
  }
  return path.join(directory, 'runtime', 'owner.sock');
}

async function serve(socketPath: string, response: string): Promise<void> {
  const server = net.createServer((socket) => socket.end(response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.push(server);
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('profile ownership lease', () => {
  it('exposes only owner identity and rejects a second runtime', async () => {
    const socketPath = await endpoint();
    const desktop = new ProfileLease('desktop', { endpoint: socketPath });
    leases.push(desktop);
    await desktop.acquire();

    expect(await probeProfileOwner(socketPath)).toEqual({
      version: 1,
      kind: 'desktop',
      pid: process.pid,
    });

    const core = new ProfileLease('core', { endpoint: socketPath });
    await expect(core.acquire()).rejects.toBeInstanceOf(ProfileOwnershipError);
    expect(await probeProfileOwner(socketPath)).toEqual({
      version: 1,
      kind: 'desktop',
      pid: process.pid,
    });

    await desktop.close();
    expect(await probeProfileOwner(socketPath)).toBeNull();
    leases.push(core);
    await core.acquire();
    expect((await probeProfileOwner(socketPath))?.kind).toBe('core');
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong protocol version', '{"version":2,"kind":"desktop","pid":123}\n'],
    ['oversized response', 'x'.repeat(1025)],
  ])('fails closed for %s', async (_name, response) => {
    const socketPath = await endpoint();
    await serve(socketPath, response);
    await expect(probeProfileOwner(socketPath)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'recovers one stale Unix socket without allowing competing owners',
    async () => {
      const socketPath = await endpoint();
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
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

      const first = new ProfileLease('desktop', { endpoint: socketPath });
      const second = new ProfileLease('core', { endpoint: socketPath });
      const results = await Promise.allSettled([first.acquire(), second.acquire()]);
      const owners = [first, second].filter((_, index) => results[index].status === 'fulfilled');
      leases.push(...owners);

      expect(owners).toHaveLength(1);
      expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
      expect(await probeProfileOwner(socketPath)).toMatchObject({
        version: 1,
        pid: process.pid,
      });
    },
  );
});
import { spawn } from 'node:child_process';
import { once } from 'node:events';
