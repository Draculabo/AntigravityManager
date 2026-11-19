import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshOwner } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.service';
import { withDshCredentialLock } from '@/modules/proxy-gateway/dsh-sync/dsh-credentials';

const plan = {
  profile: 'web',
  action: 'sync' as const,
  protocol: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:8045/v1',
  credentialMode: 'existing-reference' as const,
  credentialRef: 'manager_key',
  models: ['gemini-3-flash'],
  activateModel: null,
};
let home: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (home) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

async function fixture(useDefaultHome = false) {
  home = await mkdtemp(path.join(os.tmpdir(), 'dsh-owner-'));
  vi.stubEnv('DSH_HOME', useDefaultHome ? undefined : home);
  if (useDefaultHome) {
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home);
  }
  const profile = path.join(useDefaultHome ? path.join(home, '.dsh') : home, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  const patchPath = path.join(profile, 'cordis.patch.yml');
  const original = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      personal:',
    '        protocol: openai-completions',
    '',
  ].join('\n');
  await writeFile(patchPath, original);
  return { patchPath, original };
}

describe('DSH owner lifecycle', () => {
  it('finds and configures the default web profile without DSH_HOME', async () => {
    const { patchPath } = await fixture(true);
    const owner = createDshOwner();
    expect(await owner.status({ profile: 'web' })).toMatchObject({ patchPath, exists: true });
    const preview = await owner.preview(plan);
    await expect(
      owner.sync({ ...plan, expectedSourceHash: preview.sourceHash }),
    ).resolves.toMatchObject({
      patchPath,
      changed: true,
    });
  });

  it.each([false, true])(
    'releases the credential lock after a work failure (async: %s)',
    async (asyncFailure) => {
      const { patchPath } = await fixture();
      const failure = new Error('Synthetic credential operation failure');
      await expect(
        withDshCredentialLock(patchPath, () => {
          if (asyncFailure) {
            return Promise.reject(failure);
          }
          throw failure;
        }),
      ).rejects.toBe(failure);
      await expect(readFile(`${patchPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(withDshCredentialLock(patchPath, async () => 'retried')).resolves.toBe(
        'retried',
      );
    },
  );

  it('retains work and cleanup failures when releasing the credential lock fails', async () => {
    const { patchPath } = await fixture();
    const failure = new Error('Synthetic credential operation failure');
    await expect(
      withDshCredentialLock(patchPath, async () => {
        await unlink(`${patchPath}.lock`);
        throw failure;
      }),
    ).rejects.toMatchObject({
      code: 'receipt-failed',
      cause: expect.objectContaining({
        errors: [failure, expect.objectContaining({ code: 'ENOENT' })],
      }),
    });
  });

  it('serializes preview and sync, returns a source hash, and detects stale writes', async () => {
    const owner = createDshOwner();
    const { patchPath, original } = await fixture();
    const preview = await owner.preview(plan);
    const result = await owner.sync({ ...plan, expectedSourceHash: preview.sourceHash });
    expect(result.changed).toBe(true);
    expect(result.patchPath).toBe(patchPath);
    expect(await readFile(`${patchPath}.antigravity-manager.bak`, 'utf8')).toBe(original);

    await expect(owner.sync({ ...plan, expectedSourceHash: preview.sourceHash })).rejects.toThrow(
      'conflict',
    );
    owner.closeAdmission();
    await owner.drain();
    await expect(owner.status({ profile: plan.profile })).rejects.toThrow('unavailable');
  });
});
