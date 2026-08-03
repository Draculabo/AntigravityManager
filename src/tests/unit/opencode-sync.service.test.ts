import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeCredentialService } from '@/modules/proxy-gateway/opencode-sync/opencode-credential.service';
import type { OpenCodeSourceAccount } from '@/modules/proxy-gateway/opencode-sync/opencode-accounts';
import { OPEN_CODE_API_KEY_PLACEHOLDER } from '@/modules/proxy-gateway/opencode-sync/opencode-jsonc-config';
import { OpenCodeSyncService } from '@/modules/proxy-gateway/opencode-sync/opencode-sync.service';

const createdDirectories: string[] = [];

async function createFixture(
  installation = { installed: false, version: null as string | null },
  accounts: OpenCodeSourceAccount[] = [],
) {
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
    service: new OpenCodeSyncService(
      homeDirectory,
      credentials,
      async () => installation,
      async () => accounts,
    ),
    getKey: () => key,
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
    const accountsPath = join(fixture.configDirectory, 'antigravity-accounts.json');
    const accountsBackupPath = `${accountsPath}.antigravity-manager.bak`;
    await writeFile(configPath, '{ "theme": "changed" }\n', 'utf8');
    await writeFile(
      backupPath,
      `{\n  // restored comment\n  "provider": {"antigravity-manager": {"options": {"apiKey": "${OPEN_CODE_API_KEY_PLACEHOLDER}"}}}\n}\n`,
      'utf8',
    );
    await writeFile(accountsPath, '{ "version": 3, "accounts": [] }\n', 'utf8');
    await writeFile(
      accountsBackupPath,
      '{ "version": 3, "accounts": [{ "refreshToken": "restored-test-token" }] }\n',
      'utf8',
    );
    fixture.setKey('agm_oc_current');

    const result = await fixture.service.restore();

    expect(result.configPath).toBe(configPath);
    const restored = await readFile(configPath, 'utf8');
    expect(restored).toContain('// restored comment');
    expect(restored).toContain('"apiKey": "agm_oc_current"');
    expect(await readFile(accountsPath, 'utf8')).toContain('restored-test-token');
    await expect(readFile(backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(accountsBackupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a legacy account-only backup without creating a dedicated key', async () => {
    const fixture = await createFixture();
    const accountsPath = join(fixture.configDirectory, 'antigravity-accounts.json');
    const legacyBackupPath = `${accountsPath}.antigravity.bak`;
    await writeFile(accountsPath, '{ "accounts": [{ "refreshToken": "changed" }] }');
    await writeFile(legacyBackupPath, '{ "accounts": [{ "refreshToken": "legacy-original" }] }');
    fixture.setKey('');

    const result = await fixture.service.restore();

    expect(result.configPath).toBe(join(fixture.configDirectory, 'opencode.json'));
    expect(await readFile(accountsPath, 'utf8')).toContain('legacy-original');
    expect(fixture.getKey()).toBe('');
    await expect(readFile(legacyBackupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('syncs schema v3 accounts from the main-process account loader with a one-time backup', async () => {
    const fixture = await createFixture(undefined, [
      {
        email: 'primary@example.com',
        refreshToken: 'new-test-refresh',
        projectId: 'new-project',
        lastUsed: 300,
      },
    ]);
    const accountsPath = join(fixture.configDirectory, 'antigravity-accounts.json');
    const existing = `${JSON.stringify({
      version: 3,
      accounts: [
        {
          email: 'primary@example.com',
          refreshToken: 'old-test-refresh',
          addedAt: 100,
          lastUsed: 400,
          enabled: false,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: {},
    })}\n`;
    await writeFile(accountsPath, existing, 'utf8');

    await fixture.service.sync({
      baseUrl: 'http://127.0.0.1:8045',
      syncAccounts: true,
    });

    expect(JSON.parse(await readFile(accountsPath, 'utf8'))).toEqual({
      version: 3,
      accounts: [
        {
          email: 'primary@example.com',
          refreshToken: 'new-test-refresh',
          projectId: 'new-project',
          addedAt: 100,
          lastUsed: 400,
          enabled: false,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    });
    expect(await readFile(`${accountsPath}.antigravity-manager.bak`, 'utf8')).toBe(existing);
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

  it('returns managed models without exposing the raw key in status', async () => {
    const fixture = await createFixture({ installed: true, version: '1.2.3' });
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    await writeFile(
      configPath,
      `{
  // preserved user comment
  "provider": {
    "antigravity-manager": {
      "options": {
        "baseURL": "http://127.0.0.1:8045/v1",
        "apiKey": "agm_oc_initial"
      },
      "models": {
        "gemini-3.5-flash": { "name": "Gemini 3.5 Flash" },
        "vendor-preview": {}
      }
    }
  },
  "plugin": ["opencode-antigravity-auth@latest"]
}
`,
      'utf8',
    );

    const status = await fixture.service.getStatus('http://127.0.0.1:8045');

    expect(status).toEqual({
      configPath,
      exists: true,
      hasBackup: false,
      isConfigured: true,
      isSynced: true,
      currentBaseUrl: 'http://127.0.0.1:8045/v1',
      hasAuthPlugin: true,
      keyConfigured: true,
      installed: true,
      version: '1.2.3',
      models: [
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'vendor-preview', name: undefined },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('agm_oc_initial');
  });

  it('clears managed and matching legacy config while revoking the dedicated key', async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    await writeFile(
      configPath,
      `{
  // preserved after clear
  "theme": "dark",
  "provider": {
    "antigravity-manager": {
      "options": { "baseURL": "http://127.0.0.1:8045/v1", "apiKey": "agm_oc_initial" }
    },
    "google": {
      "options": { "baseURL": "http://127.0.0.1:8045", "apiKey": "legacy-key" },
      "models": { "gemini-3-flash": {}, "user-model": {} }
    }
  }
}
`,
      'utf8',
    );

    const result = await fixture.service.clear({
      baseUrl: 'http://127.0.0.1:8045',
      clearLegacy: true,
    });

    expect(result.configPath).toBe(configPath);
    const cleared = await readFile(configPath, 'utf8');
    const backup = await readFile(`${configPath}.antigravity-manager.bak`, 'utf8');
    expect(cleared).toContain('// preserved after clear');
    expect(cleared).toContain('"theme": "dark"');
    expect(cleared).toContain('"user-model"');
    expect(cleared).not.toContain('"antigravity-manager"');
    expect(cleared).not.toContain('"gemini-3-flash"');
    expect(cleared).not.toContain('legacy-key');
    expect(backup).toContain(OPEN_CODE_API_KEY_PLACEHOLDER);
    expect(backup).not.toContain('agm_oc_initial');
    expect(fixture.getKey()).toBe('');
  });

  it('restores an account backup during clear and deletes an unbacked account file', async () => {
    const restoredFixture = await createFixture();
    const restoredAccountsPath = join(restoredFixture.configDirectory, 'antigravity-accounts.json');
    const restoredBackupPath = `${restoredAccountsPath}.antigravity-manager.bak`;
    await writeFile(restoredAccountsPath, '{ "accounts": [{ "refreshToken": "changed" }] }');
    await writeFile(restoredBackupPath, '{ "accounts": [{ "refreshToken": "original" }] }');

    await restoredFixture.service.clear({
      baseUrl: 'http://127.0.0.1:8045',
      clearLegacy: true,
    });

    expect(await readFile(restoredAccountsPath, 'utf8')).toContain('original');
    await expect(readFile(restoredBackupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const deletedFixture = await createFixture();
    const deletedAccountsPath = join(deletedFixture.configDirectory, 'antigravity-accounts.json');
    await writeFile(deletedAccountsPath, '{ "accounts": [] }');

    await deletedFixture.service.clear({
      baseUrl: 'http://127.0.0.1:8045',
      clearLegacy: true,
    });

    await expect(readFile(deletedAccountsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns only a parsed and recursively redacted configuration preview', async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.configDirectory, 'opencode.jsonc');
    await writeFile(
      configPath,
      `{
  // comment-secret-must-not-cross-ipc
  "provider": {
    "antigravity-manager": {
      "options": {
        "baseURL": "http://127.0.0.1:8045/v1",
        "apiKey": "raw-api-key",
        "nested": { "refresh_token": "raw-refresh-token" }
      }
    }
  },
  "password": "raw-password"
}
`,
      'utf8',
    );

    const preview = await fixture.service.readConfigForDisplay();

    expect(preview).toEqual({
      configPath,
      fileName: 'opencode.jsonc',
      content: `${JSON.stringify(
        {
          provider: {
            'antigravity-manager': {
              options: {
                baseURL: 'http://127.0.0.1:8045/v1',
                apiKey: '[REDACTED]',
                nested: { refresh_token: '[REDACTED]' },
              },
            },
          },
          password: '[REDACTED]',
        },
        null,
        2,
      )}\n`,
    });
    expect(preview.content).not.toContain('comment-secret-must-not-cross-ipc');
    expect(preview.content).not.toContain('raw-');
  });
});
