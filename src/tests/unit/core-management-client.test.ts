import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ManagementClient,
  ManagementProtocolError,
  ManagementTimeoutError,
  OAuthManagementError,
  ServiceNotRunningError,
} from '@/core/management/client';
import { ManagementServer } from '@/core/management/server';

const closeables: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-client-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agm-client-${path.basename(directory)}`
    : path.join(directory, 'core.sock');
}

async function fakeHttpServer(
  endpointPath: string,
  respond: (response: http.ServerResponse) => void,
): Promise<void> {
  const server: Server = http.createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => server.listen(endpointPath, resolve));
  closeables.push({
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('ManagementClient', () => {
  it('reads status and acknowledges shutdown over the real local transport', async () => {
    const socketPath = await endpoint();
    const status = {
      state: 'running' as const,
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
    closeables.push(server);
    await server.start();

    const client = new ManagementClient(socketPath);
    expect(await client.status()).toEqual(status);
    await client.shutdown();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it('classifies an absent service separately from a malformed response', async () => {
    const socketPath = await endpoint();
    await expect(new ManagementClient(socketPath).status()).rejects.toBeInstanceOf(
      ServiceNotRunningError,
    );

    await fakeHttpServer(socketPath, (response) => {
      response.end(JSON.stringify({ version: 2, ok: true, status: {} }));
    });
    await expect(new ManagementClient(socketPath).status()).rejects.toBeInstanceOf(
      ManagementProtocolError,
    );
  });

  it('bounds a stalled response and oversized response', async () => {
    const stalledPath = await endpoint();
    await fakeHttpServer(stalledPath, () => {});
    await expect(new ManagementClient(stalledPath, 50).status()).rejects.toBeInstanceOf(
      ManagementTimeoutError,
    );

    const oversizedPath = await endpoint();
    await fakeHttpServer(oversizedPath, (response) => {
      response.end('x'.repeat(5000));
    });
    await expect(new ManagementClient(oversizedPath).status()).rejects.toBeInstanceOf(
      ManagementProtocolError,
    );
  });

  it('starts and polls OAuth without returning an authorization code', async () => {
    const socketPath = await endpoint();
    const oauth = {
      start: vi.fn(async () => ({
        sessionId: '11111111-1111-4111-8111-111111111111',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      })),
      status: vi.fn((sessionId: string) =>
        sessionId === '11111111-1111-4111-8111-111111111111' ? { state: 'pending' as const } : null,
      ),
      cancel: vi.fn(async () => {}),
      completeCode: vi.fn(() => true),
    };
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      oauth,
    });
    closeables.push(server);
    await server.start();

    const client = new ManagementClient(socketPath);
    expect(await client.startOAuth('client-b')).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
    });
    expect(oauth.start).toHaveBeenCalledExactlyOnceWith('client-b');
    expect(await client.oauthStatus('11111111-1111-4111-8111-111111111111')).toEqual({
      state: 'pending',
    });
    await client.completeOAuth('11111111-1111-4111-8111-111111111111', '4/manual-code');
    expect(oauth.completeCode).toHaveBeenCalledExactlyOnceWith(
      '11111111-1111-4111-8111-111111111111',
      '4/manual-code',
    );
    await expect(
      client.completeOAuth('11111111-1111-4111-8111-111111111111', 'bad code'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await client.cancelOAuth('11111111-1111-4111-8111-111111111111');
    await client.cancelOAuth('11111111-1111-4111-8111-111111111111');
    expect(oauth.cancel).toHaveBeenCalledTimes(2);
    expect(oauth.cancel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    await expect(client.cancelOAuth('not-a-session')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(oauth.cancel).toHaveBeenCalledTimes(2);
    await expect(client.startOAuth('x'.repeat(129))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(client.oauthStatus('22222222-2222-4222-8222-222222222222')).rejects.toBeInstanceOf(
      OAuthManagementError,
    );
  });
});
