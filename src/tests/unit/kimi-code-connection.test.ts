import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionProfileSaveInput } from '@/modules/proxy-gateway/connection-profiles/connection-profiles.schema';

const fixture = vi.hoisted(() => ({
  directory: '',
  passwordByAccount: new Map<string, string>(),
}));

vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getAgentDir: () => fixture.directory,
}));
vi.mock('@/modules/config/service-config.service', () => ({
  serviceConfigService: { revealSecret: async () => ({ value: 'test-manager-key' }) },
}));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      readonly service: string,
      readonly account: string,
    ) {}
    getPassword() {
      return fixture.passwordByAccount.get(this.account) ?? null;
    }
    setPassword(value: string) {
      fixture.passwordByAccount.set(this.account, value);
    }
    deleteCredential() {
      fixture.passwordByAccount.delete(this.account);
    }
  },
}));

import { createConnectionProfilesOwner } from '@/modules/proxy-gateway/connection-profiles/connection-profiles.owner';

afterEach(async () => {
  vi.unstubAllEnvs();
  fixture.passwordByAccount.clear();
  if (fixture.directory) {
    await rm(fixture.directory, { recursive: true, force: true });
    fixture.directory = '';
  }
});

it('adds only owned Kimi Code entries and restores the original model selection on removal', async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), 'agm-kimi-connection-'));
  vi.stubEnv('KIMI_CODE_HOME', fixture.directory);
  const file = join(fixture.directory, 'config.toml');
  await writeFile(
    file,
    'default_model = "personal"\n[providers.personal]\ntype = "openai"\napi_key = "native-key"\n' +
      '[models.personal]\nprovider = "personal"\nmodel = "personal-model"\nmax_context_size = 32000\n',
  );
  const original = parse(await readFile(file, 'utf8'));
  const owner = createConnectionProfilesOwner();
  const input: ConnectionProfileSaveInput = {
    name: 'Local gateway',
    client: 'kimi-code',
    baseUrl: 'http://127.0.0.1:3080/v1/',
    protocol: 'openai-completions',
    sdk: null,
    models: ['claude-sonnet-4-6', 'gemini-3.8-flash-high'],
    activateModel: null,
    version: null,
    discoverModels: false,
    dshProfile: null,
    credentialSource: 'manager-default',
  };
  let saved = await owner.save(input);
  const provider = 'antigravity-manager-' + saved.id;
  const apply = async (action: 'apply' | 'remove') => {
    const preview = await owner.preview({ id: saved.id, action });
    expect(preview.configPath).toBe(file);
    return owner.mutate({ id: saved.id, action, expectedSourceHash: preview.sourceHash });
  };
  await apply('apply');
  expect(parse(await readFile(file, 'utf8'))).toMatchObject({
    default_model: 'personal',
    providers: {
      personal: { api_key: 'native-key' },
      [provider]: {
        type: 'openai',
        base_url: 'http://127.0.0.1:3080/v1',
        api_key: 'test-manager-key',
      },
    },
    models: {
      [provider + '/claude-sonnet-4-6']: {
        provider,
        model: 'claude-sonnet-4-6',
        max_context_size: 200000,
      },
    },
  });

  saved = await owner.save({
    ...input,
    id: saved.id,
    expectedRevision: saved.revision,
    activateModel: 'gemini-3.8-flash-high',
    credentialSource: 'keep',
  });
  await apply('apply');
  expect(parse(await readFile(file, 'utf8')).default_model).toBe(
    provider + '/gemini-3.8-flash-high',
  );
  await apply('remove');
  expect(parse(await readFile(file, 'utf8'))).toEqual(original);

  const stale = await owner.preview({ id: saved.id, action: 'apply' });
  await writeFile(file, (await readFile(file, 'utf8')) + '\n# edited after preview\n');
  await expect(
    owner.mutate({ id: saved.id, action: 'apply', expectedSourceHash: stale.sourceHash }),
  ).rejects.toMatchObject({ code: 'conflict' });

  await apply('apply');
  const selected = await readFile(file, 'utf8');
  await writeFile(
    file,
    selected.replace(
      /^default_model = .*$/mu,
      'default_model = "' + provider + '/claude-sonnet-4-6"',
    ),
  );
  await expect(owner.preview({ id: saved.id, action: 'remove' })).rejects.toMatchObject({
    code: 'conflict',
  });
  await writeFile(file, selected.replace(/^default_model = .*$/mu, 'default_model = "manual"'));
  await apply('remove');
  expect(parse(await readFile(file, 'utf8'))).toEqual({ ...original, default_model: 'manual' });
});
