import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeCredentialService } from '@/modules/proxy-gateway/opencode-sync/opencode-credential.service';
import { OPEN_CODE_API_KEY_PLACEHOLDER } from '@/modules/proxy-gateway/opencode-sync/opencode-jsonc-config';
import { OpenCodeSyncService } from '@/modules/proxy-gateway/opencode-sync/opencode-sync.service';

const createdDirectories: string[] = [];

async function createFixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'agm-opencode-'));
  createdDirectories.push(homeDirectory);
  const configDirectory = join(homeDirectory, '.config', 'opencode');
  await mkdir(configDirectory, { recursive: true });

  let key = 'agm_oc_initial';
  const credentials = new OpenCodeCredentialService({
    read: () => key,
    write: (value) => {
      key = value;
    },
    delete: () => {
      key = '';
    },
  });

  return {
    configDirectory,
    homeDirectory,
    service: new OpenCodeSyncService(homeDirectory, credentials),
    setKey: (value: string) => {
      key = value;
    },
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('OpenCodeSyncService', () => {
  it('prefers an existing JSONC file and creates a redacted one-time backup', async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    await writeFile(
      configPath,
      '{\n  // user comment\n  "provider": {"antigravity-manager": {"options": {"apiKey": "legacy-key"}}}\n}\n',
      'utf8',
    );

    const result = await fixture.service.sync({
      baseUrl: 'http://127.0.0.1:8045',
      models: [{ id: 'gemini-3.1-pro' }],
    });

    expect(result.configPath).toBe(configPath);
    const synced = await readFile(configPath, 'utf8');
    const backup = await readFile(`${configPath}.antigravity-manager.bak`, 'utf8');
    expect(synced).toContain('// user comment');
    expect(synced).toContain('"apiKey": "agm_oc_initial"');
    expect(backup).toContain(OPEN_CODE_API_KEY_PLACEHOLDER);
    expect(backup).not.toContain('legacy-key');
    expect(backup).not.toContain('agm_oc_initial');
  });

  it('restores the backup while injecting the currently valid dedicated key', async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    const backupPath = `${configPath}.antigravity-manager.bak`;
    await writeFile(configPath, '{ "theme": "changed" }\n', 'utf8');
    await writeFile(
      backupPath,
      `{\n  // restored comment\n  "provider": {"antigravity-manager": {"options": {"apiKey": "${OPEN_CODE_API_KEY_PLACEHOLDER}"}}}\n}\n`,
      'utf8',
    );
    fixture.setKey('agm_oc_current');

    const result = await fixture.service.restore();

    expect(result.configPath).toBe(configPath);
    const restored = await readFile(configPath, 'utf8');
    expect(restored).toContain('// restored comment');
    expect(restored).toContain('"apiKey": "agm_oc_current"');
    await expect(readFile(backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a malformed legacy backup instead of retaining an unknown raw key', async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    const backupPath = `${configPath}.antigravity-manager.bak`;
    await writeFile(
      configPath,
      '{ "provider": {"antigravity-manager": {"options": {"apiKey": "config-key"}}} }\n',
      'utf8',
    );
    await writeFile(backupPath, '{ broken "apiKey": "agm_oc_unknown-secret"', 'utf8');

    await fixture.service.sync({
      baseUrl: 'http://127.0.0.1:8045',
    });

    const backup = await readFile(backupPath, 'utf8');
    expect(backup).not.toContain('agm_oc_unknown-secret');
    expect(backup).not.toContain('config-key');
    expect(backup).toContain(OPEN_CODE_API_KEY_PLACEHOLDER);
  });

  it('never exposes the raw key in status', async () => {
    const fixture = await createFixture();

    const status = await fixture.service.getStatus('http://127.0.0.1:8045');

    expect(JSON.stringify(status)).not.toContain('agm_oc_initial');
    expect(status.keyConfigured).toBe(true);
  });
});
