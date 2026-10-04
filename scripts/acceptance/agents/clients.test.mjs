import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClient } from './clients.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('one-click verification uses generated settings without credential/model/endpoint overrides', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-client-settings-'));
  try {
    const source = '# Configured by the production tool service\nmodel="chosen-model"\n';
    await fs.writeFile(path.join(home, 'config.toml'), source);
    for (const client of ['claude', 'codex']) {
      const command = await createClient({
        client,
        clientSettings: home,
        home,
        workspace: home,
        gateway: 'http://must-not-override.test',
        model: 'must-not-override',
        apiKey: 'must-not-inject',
        codexApproval: 'auto',
        claudeSystemPrompt: 'default',
        claudeMaxOutputTokens: null,
      });
      assert.equal(command.env[client === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], home);
      for (const key of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
      ]) {
        assert.equal(command.env[key], undefined);
      }
      assert.equal(command.args.includes('--model'), false);
      if (client === 'claude') {
        assert.equal(
          command.args[command.args.indexOf('--settings') + 1],
          path.join(home, 'settings.json'),
        );
      }
      assert.equal(command.args.includes('must-not-override'), false);
      assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), source);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('Claude acceptance isolates inherited settings and labels its explicit diagnostic mode', async () => {
  const inheritedOutputCap = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  const inheritedThinking = process.env.CLAUDE_CODE_DISABLE_THINKING;
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '12345';
  process.env.CLAUDE_CODE_DISABLE_THINKING = '1';
  try {
    const options = {
      client: 'claude',
      bin: 'claude',
      gateway: 'http://127.0.0.1:18045',
      home: '/isolated/home',
      workspace: '/isolated/workspace',
      model: 'claude-sonnet-4-6-thinking',
      apiKey: 'test-only-key',
    };
    const stock = await createClient({
      ...options,
      claudeSystemPrompt: 'default',
      claudeMaxOutputTokens: null,
    });
    assert.equal(stock.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    assert.equal(stock.env.CLAUDE_CODE_DISABLE_THINKING, undefined);
    assert.equal(stock.env.PWD, options.workspace);
    assert.equal(stock.args.includes('--system-prompt'), false);

    const diagnostic = await createClient({
      ...options,
      claudeSystemPrompt: 'compact',
      claudeMaxOutputTokens: 4096,
    });
    assert.equal(diagnostic.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096');
    assert.equal(diagnostic.env.CLAUDE_CODE_DISABLE_THINKING, undefined);
    assert.equal(diagnostic.args.includes('--system-prompt'), true);
  } finally {
    if (inheritedOutputCap === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = inheritedOutputCap;
    }
    if (inheritedThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING;
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = inheritedThinking;
    }
  }
});

test('Codex shell diagnostic changes only process startup and preserves generated settings', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-codex-shell-'));
  try {
    const source = 'model="synthetic-model"\nmodel_provider="synthetic-provider"\n';
    await fs.writeFile(path.join(home, 'config.toml'), source);
    const options = {
      client: 'codex',
      clientSettings: home,
      home,
      workspace: home,
      codexApproval: 'auto',
    };
    const stock = await createClient(options);
    const diagnostic = await createClient({ ...options, codexShellProfile: 'disabled' });
    assert.equal(stock.args.includes('allow_login_shell=false'), false);
    const diagnosticOverrides = diagnostic.args.slice(
      diagnostic.args.indexOf('-c'),
      diagnostic.args.indexOf('-c') + 2,
    );
    assert.deepEqual(diagnosticOverrides, ['-c', 'allow_login_shell=false']);
    assert.deepEqual(
      diagnostic.args.filter((arg) => !diagnosticOverrides.includes(arg)),
      stock.args,
    );
    assert.deepEqual(diagnostic.env, stock.env);
    assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), source);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
