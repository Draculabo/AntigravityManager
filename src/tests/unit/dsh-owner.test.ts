import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDshOwner } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.service';

const provider = {
  id: 'manager',
  protocol: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:8045/v1',
  credentialRef: 'manager-key',
  models: [{ id: 'gemini-3-flash' }],
};

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-owner-'));
  const profile = path.join(home, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    ['config:', '  providers:', '    personal:', '      protocol: openai-completions', ''].join(
      '\n',
    ),
  );
  return { home, profile: 'web' };
}

describe('DSH owner lifecycle', () => {
  it('serializes preview and sync, returns a source hash, and detects stale writes', async () => {
    const owner = createDshOwner();
    const target = await fixture();
    const preview = await owner.preview({ ...target, provider });
    const result = await owner.sync({ ...target, provider, expectedSourceHash: preview.sourceHash });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toContain('.antigravity-manager.bak');

    await expect(
      owner.sync({ ...target, provider, expectedSourceHash: preview.sourceHash }),
    ).rejects.toThrow('operation-failed');
    owner.closeAdmission();
    await owner.drain();
    await expect(owner.status(target)).rejects.toThrow('unavailable');
  });
});
