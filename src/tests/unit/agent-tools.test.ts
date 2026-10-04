import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentToolsService } from '@/modules/proxy-gateway/agent-tools/agent-tools.service';
import {
  configureCodex,
  readCodexSettings,
} from '@/modules/proxy-gateway/agent-tools/codex-settings';
import { readClaudeSettings } from '@/modules/proxy-gateway/agent-tools/claude-settings';
import { createAgentToolsRouter } from '@/modules/proxy-gateway/agent-tools/agent-tools.router';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import type { AgentTool } from '@/modules/proxy-gateway/agent-tools/agent-tools.schema';

const key = 'fixture-manager-key-never-returned';
const model = 'claude-sonnet-4-6-thinking';
const baseUrl = 'http://127.0.0.1:8045/v1/';
let home: string;
let service: AgentToolsService;
const ensureReviewRoute = vi.fn(async (_model: string) => {});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agm-agent-tools-'));
  ensureReviewRoute.mockClear();
  service = new AgentToolsService({
    home,
    env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined },
    key: async () => key,
    ensureReviewRoute,
    detect: async () => ({ installed: true, version: '1.2.3' }),
  });
});
afterEach(async () => {
  await service.drain();
  await rm(home, { recursive: true, force: true });
});
function configPath(tool: AgentTool) {
  return join(
    home,
    tool === 'claude' ? '.claude' : '.codex',
    tool === 'claude' ? 'settings.json' : 'config.toml',
  );
}
const sources = {
  claude:
    '// original settings\n{"model":"previous","env":{"ANTHROPIC_AUTH_TOKEN":"fixture-old-login","OTHER":"fixture-private-environment"},"hooks":{"custom":"fixture-private-hook"},"permissions":{"allow":["Read"]}}\n',
  codex:
    '# Original comment\nmodel="previous"\nmodel_provider="original"\nsandbox_mode="workspace-write"\napproval_policy="on-request"\n[model_providers.original]\nname="Original"\nwire_api="responses"\nbase_url="http://example.test/v1"\n',
};

describe.each<AgentTool>(['claude', 'codex'])('%s tool configuration', (tool) => {
  it('configures, inspects, previews, removes only owned fields, and restores original bytes', async () => {
    const path = configPath(tool);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, sources[tool]);
    const router = createRouterClient(createAgentToolsRouter(service));
    expect(await router.configure({ tool, model, baseUrl })).toEqual({
      configPath: path,
      restartRequired: true,
    });
    expect(await router.status({ tool, baseUrl })).toEqual({
      tool,
      installed: true,
      version: '1.2.3',
      configPath: path,
      exists: true,
      hasBackup: true,
      isConfigured: true,
      isSynced: true,
      currentBaseUrl: tool === 'codex' ? 'http://127.0.0.1:8045/v1' : 'http://127.0.0.1:8045',
      model,
    });
    const preview = await router.preview({ tool });
    expect(preview.content).not.toContain(key);
    expect(preview.content).not.toContain('fixture-old-login');
    expect(preview.content).not.toMatch(/fixture-private-environment|fixture-private-hook/);
    expect(JSON.parse(preview.content)).toEqual({
      model,
      baseUrl: tool === 'codex' ? 'http://127.0.0.1:8045/v1' : 'http://127.0.0.1:8045',
      credential: '[REDACTED]',
    });
    await router.configure({ tool, model: 'gemini-3.1-pro-high', baseUrl });
    const backup = JSON.parse(await readFile(`${path}.antigravity-manager.bak`, 'utf8'));
    expect(backup).toEqual({ version: 1, original: sources[tool] });
    const current = await readFile(path, 'utf8');
    await writeFile(
      path,
      tool === 'codex'
        ? current + '\n[unrelated_new_setting]\nenabled = true\n'
        : current.replace('{', '{"unrelated_new_setting":{"enabled":true},'),
    );
    await router.remove({ tool });
    const removed =
      tool === 'codex'
        ? readCodexSettings(await readFile(path, 'utf8'))
        : readClaudeSettings(await readFile(path, 'utf8'));
    expect(removed.unrelated_new_setting).toEqual({ enabled: true });
    expect(removed.model).toBe('previous');
    expect(removed).not.toHaveProperty('ANTIGRAVITY_MANAGER_CONFIGURED');
    if (tool === 'codex') {
      expect(removed).toMatchObject({
        sandbox_mode: 'workspace-write',
        approval_policy: 'on-request',
        model_provider: 'original',
      });
    }
    await router.restore({ tool });
    expect(await readFile(path, 'utf8')).toBe(sources[tool]);
    await expect(access(`${path}.antigravity-manager.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(ensureReviewRoute.mock.calls).toEqual(
      tool === 'codex' ? [[model], ['gemini-3.1-pro-high']] : [],
    );
  });
  it('restores a previously missing file by removing the newly created settings', async () => {
    await service.configure({ tool, model, baseUrl });
    await service.restore(tool);
    await expect(access(configPath(tool))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects malformed configuration without writing a backup or resetting settings', async () => {
    const path = configPath(tool);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not valid configuration');
    await expect(service.configure({ tool, model, baseUrl })).rejects.toMatchObject({
      code: 'invalid-config',
    });
    expect(await readFile(path, 'utf8')).toBe('not valid configuration');
    await expect(access(`${path}.antigravity-manager.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
it('stops before changing settings when a backup cannot be saved', async () => {
  service = new AgentToolsService({
    home,
    env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined },
    key: async () => key,
    ensureReviewRoute,
    detect: async () => ({ installed: false, version: null }),
    write: async () => {
      throw new Error('fixture failure with private details');
    },
  });
  const path = configPath('codex');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sources.codex);
  const router = createRouterClient(createAgentToolsRouter(service));
  await expect(router.configure({ tool: 'codex', baseUrl, model })).rejects.toMatchObject({
    message: 'Could not update the tool settings. Please try again.',
    data: { agentToolCode: 'backup-failed' },
  });
  expect(await readFile(path, 'utf8')).toBe(sources.codex);
  expect(ensureReviewRoute).not.toHaveBeenCalled();
});
it('retains recovery when writing the active file fails', async () => {
  service = new AgentToolsService({
    home,
    env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined },
    key: async () => key,
    ensureReviewRoute,
    detect: async () => ({ installed: false, version: null }),
    write: async (path, content, options) => {
      if (!path.endsWith('.bak')) {
        throw new Error('fixture active write failure');
      }
      await writeFileAtomic(path, content, options);
    },
  });
  await expect(service.configure({ tool: 'claude', model, baseUrl })).rejects.toMatchObject({
    code: 'write-failed',
  });
  expect(
    JSON.parse(await readFile(`${configPath('claude')}.antigravity-manager.bak`, 'utf8')),
  ).toEqual({ version: 1, original: null });
});
it('uses explicit client home overrides', async () => {
  service = new AgentToolsService({
    home,
    env: { CLAUDE_CONFIG_DIR: join(home, 'custom-claude'), CODEX_HOME: join(home, 'custom-codex') },
    key: async () => key,
    ensureReviewRoute,
    detect: async () => ({ installed: false, version: null }),
  });
  expect(await service.configure({ tool: 'claude', model, baseUrl })).toEqual({
    configPath: join(home, 'custom-claude', 'settings.json'),
    restartRequired: true,
  });
  expect(await service.configure({ tool: 'codex', model, baseUrl })).toEqual({
    configPath: join(home, 'custom-codex', 'config.toml'),
    restartRequired: true,
  });
});
it('refuses stale removal after a different provider changes the connection', async () => {
  await service.configure({ tool: 'claude', model, baseUrl });
  const path = configPath('claude');
  await writeFile(path, '{"env":{"ANTHROPIC_API_KEY":"different-provider-key"}}');
  await expect(service.remove('claude')).rejects.toMatchObject({ code: 'configuration-changed' });
  expect(await readFile(path, 'utf8')).toBe(
    '{"env":{"ANTHROPIC_API_KEY":"different-provider-key"}}',
  );
});
it('drains admitted writes and rejects later calls after shutdown admission closes', async () => {
  const writing = service.configure({ tool: 'claude', model, baseUrl });
  service.closeAdmission();
  await service.drain();
  expect(await writing).toEqual({ configPath: configPath('claude'), restartRequired: true });
  await expect(service.preview('claude')).rejects.toMatchObject({ code: 'unavailable' });
});
it('rejects invalid addresses at the RPC boundary', async () => {
  const router = createRouterClient(createAgentToolsRouter(service));
  await expect(
    router.configure({ tool: 'codex', model, baseUrl: 'http://user:secret@example.test/v1' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(ensureReviewRoute).not.toHaveBeenCalled();
});
it('Codex configuration leaves the original auth file untouched', async () => {
  const path = join(home, '.codex', 'auth.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'fixture-existing-google-or-openai-login');
  await service.configure({ tool: 'codex', model, baseUrl });
  expect(await readFile(path, 'utf8')).toBe('fixture-existing-google-or-openai-login');
  expect(readCodexSettings(configureCodex(sources.codex, baseUrl, model, key))).toMatchObject({
    sandbox_mode: 'workspace-write',
    approval_policy: 'on-request',
  });
});
