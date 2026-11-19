import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  describeNativeWrite,
  recoverNativeConfig,
} from '@/modules/proxy-gateway/connection-profiles/connection-config-write';

afterEach(async () => {
  vi.unstubAllEnvs();
  fixture.passwordByAccount.clear();
  if (fixture.directory) {
    await rm(fixture.directory, { recursive: true, force: true });
    fixture.directory = '';
  }
});

it.each([{ allow: undefined }, { allow: [] }, { allow: ['personal/*'] }])(
  'preserves OpenClaw allow policy $allow through setup and removal',
  async ({ allow }) => {
    fixture.directory = await mkdtemp(join(tmpdir(), 'agm-native-openclaw-'));
    const settings = join(fixture.directory, 'openclaw.json');
    vi.stubEnv('OPENCLAW_CONFIG_PATH', settings);
    const original = {
      agents: { defaults: { modelPolicy: { allow } } },
      models: { providers: {} },
    };
    await writeFile(settings, JSON.stringify(original));
    const owner = createConnectionProfilesOwner();
    const profile = await owner.save({
      name: 'Local gateway',
      client: 'openclaw',
      baseUrl: 'http://127.0.0.1:3080',
      protocol: 'openai-completions',
      sdk: null,
      models: ['gemini-3-flash'],
      activateModel: null,
      version: 'v2',
      discoverModels: false,
      dshProfile: null,
      credentialSource: 'manager-default',
    });
    const apply = await owner.preview({ id: profile.id, action: 'apply' });
    await owner.mutate({ id: profile.id, action: 'apply', expectedSourceHash: apply.sourceHash });
    expect(JSON.parse(await readFile(settings, 'utf8')).agents.defaults.modelPolicy.allow).toEqual(
      allow?.length ? [...allow, `antigravity-manager-${profile.id}/*`] : allow,
    );
    const remove = await owner.preview({ id: profile.id, action: 'remove' });
    await owner.mutate({ id: profile.id, action: 'remove', expectedSourceHash: remove.sourceHash });
    expect(JSON.parse(await readFile(settings, 'utf8')).agents.defaults.modelPolicy.allow).toEqual(
      allow,
    );
  },
);

it.each(['qwen-code', 'pi', 'gemini-cli'] as const)(
  'previews, applies and restores the native %s configuration',
  async (client) => {
    fixture.directory = await mkdtemp(join(tmpdir(), 'agm-native-agent-'));
    vi.stubEnv('QWEN_HOME', fixture.directory);
    vi.stubEnv('PI_CODING_AGENT_DIR', fixture.directory);
    vi.stubEnv('GEMINI_CLI_HOME', fixture.directory);
    const directory =
      client === 'gemini-cli' ? join(fixture.directory, '.gemini') : fixture.directory;
    await mkdir(directory, { recursive: true });
    const settings = join(directory, 'settings.json');
    const models = join(directory, 'models.json');
    const environment = join(directory, '.env');
    const original = {
      unrelated: { kept: true },
      defaultProvider: 'personal',
      defaultModel: 'existing-model',
      security: { auth: { selectedType: 'personal' } },
      model: { name: 'existing-model' },
    };
    const originalModels = { providers: { personal: { baseUrl: 'https://example.test/v1' } } };
    const originalEnvironment = 'OTHER_KEY="preserve this"\nGEMINI_API_KEY="test-existing-key"\n';
    await writeFile(settings, JSON.stringify(original));
    await writeFile(models, JSON.stringify(originalModels));
    await writeFile(environment, originalEnvironment);
    const owner = createConnectionProfilesOwner();
    const model = 'gemini-3.8-flash-high';
    const input: ConnectionProfileSaveInput = {
      name: 'Local gateway',
      client,
      baseUrl: 'http://127.0.0.1:3080/v1',
      protocol: client === 'gemini-cli' ? 'gemini-native' : 'openai-completions',
      sdk: null,
      models: [model],
      activateModel: model,
      version: null,
      discoverModels: false,
      dshProfile: null,
      credentialSource: 'manager-default',
    };
    const saved = await owner.save(input);
    const provider = 'antigravity-manager-' + saved.id;
    if (client === 'gemini-cli') {
      await writeFile(settings, '{');
      await expect(owner.preview({ id: saved.id, action: 'apply' })).rejects.toMatchObject({
        code: 'invalid-config',
      });
      expect(await readFile(environment, 'utf8')).toBe(originalEnvironment);
      await writeFile(settings, JSON.stringify(original));
    }
    const apply = await owner.preview({ id: saved.id, action: 'apply' });
    expect(apply.additionalConfigPath).toBe(client === 'qwen-code' ? undefined : settings);
    await owner.mutate({ id: saved.id, action: 'apply', expectedSourceHash: apply.sourceHash });
    const configured = JSON.parse(await readFile(settings, 'utf8'));
    if (client === 'qwen-code') {
      expect(configured).toMatchObject({
        modelProviders: { openai: [{ id: model, baseUrl: input.baseUrl }] },
        security: { auth: { selectedType: 'openai' } },
      });
      const unrelatedRoute = { id: 'personal-model', baseUrl: 'https://example.test/v1' };
      configured.modelProviders.openai.push(unrelatedRoute);
      await writeFile(settings, JSON.stringify(configured));
    } else if (client === 'pi') {
      expect(configured).toMatchObject({ defaultProvider: provider, defaultModel: model });
      expect(JSON.parse(await readFile(models, 'utf8'))).toMatchObject({
        providers: {
          [provider]: {
            api: 'openai-completions',
            apiKey: 'test-manager-key',
            models: [{ id: model }],
          },
        },
      });
    } else {
      expect(configured).toMatchObject({
        security: { auth: { selectedType: 'gemini-api-key' } },
        model: { name: model },
      });
      expect(await readFile(environment, 'utf8')).toContain(
        'GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:3080"',
      );
    }
    const remove = await owner.preview({ id: saved.id, action: 'remove' });
    await owner.mutate({ id: saved.id, action: 'remove', expectedSourceHash: remove.sourceHash });
    expect(JSON.parse(await readFile(settings, 'utf8'))).toMatchObject(original);
    if (client === 'qwen-code') {
      expect(JSON.parse(await readFile(settings, 'utf8'))).toMatchObject({
        modelProviders: { openai: [{ id: 'personal-model', baseUrl: 'https://example.test/v1' }] },
      });
    }
    expect(JSON.parse(await readFile(models, 'utf8'))).toEqual(originalModels);
    expect(await readFile(environment, 'utf8')).toBe(originalEnvironment);
    expect((await owner.list())[0]).toMatchObject({ applied: false });
  },
);

it('resumes a confirmed first config change and refuses a modified companion', async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), 'agm-native-write-'));
  const first = { filename: join(fixture.directory, 'first'), source: 'A', updated: 'B' };
  const second = { filename: join(fixture.directory, 'second'), source: 'C', updated: 'D' };
  const start = describeNativeWrite(first);
  const following = { ...describeNativeWrite(second), afterSource: second.updated };
  await writeFile(first.filename, first.updated);
  await writeFile(second.filename, second.source);
  expect(await recoverNativeConfig(start, following)).toBe('after');
  expect(await readFile(second.filename, 'utf8')).toBe(second.updated);

  await writeFile(second.filename, 'external edit');
  await expect(recoverNativeConfig(start, following)).rejects.toMatchObject({ code: 'conflict' });
  expect(await readFile(second.filename, 'utf8')).toBe('external edit');
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
