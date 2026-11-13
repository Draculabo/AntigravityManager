import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from '@/cli/app';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { createDshOwner } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.service';
import { DshPreviewSchema } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.schema';

afterEach(() => vi.unstubAllEnvs());

it('previews, rejects a stale change, applies and removes DSH settings over the private Core endpoint', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-dsh-cli-'));
  vi.stubEnv('DSH_HOME', home);
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\${path.basename(home)}`
      : path.join(home, 'core.sock');
  const owner = createDshOwner();
  const operations = createCoreRpcOperations({
    startGateway: vi.fn(),
    stopGateway: vi.fn(),
    manualStartGateway: vi.fn(),
    manualStopGateway: vi.fn(),
    retryGatewaySaveChoice: vi.fn(),
  });
  const server = new ManagementServer({
    endpoint: socketPath,
    getStatus: () => ({
      state: 'running',
      pid: process.pid,
      gateway: { running: false, port: null },
    }),
    shutdown: vi.fn(),
    onShutdownError: vi.fn(),
    rpc: { ...operations, dsh: owner },
  });
  const profile = path.join(home, 'profiles', 'web');
  const patchPath = path.join(profile, 'cordis.patch.yml');
  const original = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      personal:',
    '        protocol: openai-completions',
    '',
  ].join('\n');
  const syncFlags = [
    '--profile',
    'web',
    '--protocol',
    'openai-completions',
    '--base-url',
    'http://127.0.0.1:8045/v1',
    '--credential-ref',
    'manager_key',
    '--model',
    'gemini-3-flash',
  ];
  const client = new CoreRpcClient(socketPath);
  const launcher = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
  const output = {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
  };
  const run = (...args: string[]) => {
    output.stdout.mockClear();
    output.stderr.mockClear();
    return runCli(['tools', 'dsh', ...args], launcher, output, undefined, undefined, client);
  };
  const preview = () => DshPreviewSchema.parse(JSON.parse(output.stdout.mock.lastCall?.[0] ?? ''));

  try {
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(patchPath, original);
    await server.start();
    expect(await run('status', '--profile', 'web')).toBe(0);
    expect(output.stdout.mock.lastCall?.[0]).toContain('"exists":true');
    expect(await run('preview', '--action', 'sync', ...syncFlags)).toBe(0);
    const initial = preview();
    expect(initial).toMatchObject({
      action: 'sync',
      providerId: 'antigravity-manager',
      credentialAction: 'preserve',
    });
    expect(await fs.readFile(patchPath, 'utf8')).toBe(original);

    const modified = `${original}# External edit\n`;
    await fs.writeFile(patchPath, modified);
    expect(await run('apply', ...syncFlags, '--source-hash', initial.sourceHash, '--yes')).toBe(1);
    expect(output.stderr.mock.lastCall?.[0]).toMatch(/conflict|preview/i);
    expect(await fs.readFile(patchPath, 'utf8')).toBe(modified);

    expect(await run('preview', '--action', 'sync', ...syncFlags)).toBe(0);
    expect(await run('apply', ...syncFlags, '--source-hash', preview().sourceHash, '--yes')).toBe(
      0,
    );
    expect(await fs.readFile(patchPath, 'utf8')).toContain('antigravity-manager:');
    expect(await fs.readFile(`${patchPath}.antigravity-manager.bak`, 'utf8')).toBe(modified);

    expect(await run('preview', '--profile', 'web', '--action', 'remove')).toBe(0);
    expect(
      await run('remove', '--profile', 'web', '--source-hash', preview().sourceHash, '--yes'),
    ).toBe(0);
    const removed = await fs.readFile(patchPath, 'utf8');
    expect(removed).toContain('personal:');
    expect(removed).not.toContain('antigravity-manager:');
  } finally {
    owner.closeAdmission();
    await owner.drain();
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}, 15_000);
