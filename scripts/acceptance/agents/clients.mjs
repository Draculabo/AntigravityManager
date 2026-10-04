import fs from 'node:fs/promises';
import path from 'node:path';
import { taskPrompt } from './summarize.mjs';

const inheritedCredentials = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AGM_API_KEY',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_CONFIG',
];

export async function createClient({
  client,
  bin,
  gateway,
  home,
  workspace,
  model,
  opencodeMajor,
  codexApproval,
  codexShellProfile = 'default',
  claudeSystemPrompt,
  claudeMaxOutputTokens,
  apiKey,
  clientSettings = null,
}) {
  const env = { ...process.env };
  for (const key of inheritedCredentials) {
    delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  delete env.CLAUDE_CODE_DISABLE_THINKING;
  delete env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.MAX_THINKING_TOKENS;
  delete env.OLDPWD;
  delete env.INIT_CWD;
  Object.assign(env, {
    PWD: workspace,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  });

  if (client === 'claude') {
    Object.assign(env, {
      ...(clientSettings
        ? {}
        : {
            ANTHROPIC_BASE_URL: gateway,
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_AUTH_TOKEN: '',
          }),
      CLAUDE_CONFIG_DIR: clientSettings ?? path.join(home, 'claude-config'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(claudeMaxOutputTokens === null
        ? {}
        : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(claudeMaxOutputTokens) }),
    });
    return {
      bin: bin ?? 'claude',
      args: [
        '-p',
        taskPrompt,
        ...(clientSettings ? [] : ['--model', model]),
        ...(claudeSystemPrompt === 'compact'
          ? [
              '--system-prompt',
              'You are a coding assistant. Use the available tools to create requested files in the current working directory. Keep your final response concise.',
            ]
          : []),
        '--restricted',
        // Restricted mode skips user files; load the real configured file explicitly for this SOP.
        ...(clientSettings ? ['--settings', path.join(clientSettings, 'settings.json')] : []),
        '--tools',
        'Read,Write,Edit',
        '--permission-mode',
        'acceptEdits',
        '--no-session-persistence',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      env,
      protocol: 'anthropic',
    };
  }

  if (client === 'codex') {
    env.CODEX_HOME = clientSettings ?? path.join(home, 'codex-config');
    if (!clientSettings) {
      env.OPENAI_API_KEY = apiKey;
      await fs.mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(env.CODEX_HOME, 'config.toml'),
        [
          `model = "${model}"`,
          'model_provider = "agm"',
          `approval_policy = "${codexApproval === 'auto' ? 'on-request' : 'never'}"`,
          'sandbox_mode = "workspace-write"',
          '[model_providers.agm]',
          'name = "Antigravity Manager"',
          `base_url = "${gateway}/v1"`,
          'env_key = "OPENAI_API_KEY"',
          'wire_api = "responses"',
        ].join('\n'),
        { mode: 0o600 },
      );
    }
    return {
      bin: bin ?? 'codex',
      args: [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        ...(codexShellProfile === 'disabled' ? ['-c', 'allow_login_shell=false'] : []),
        ...(codexApproval === 'auto' ? ['--approve-for-me'] : ['--sandbox', 'workspace-write']),
        '--json',
        '--color',
        'never',
        taskPrompt,
      ],
      env,
      protocol: 'openai-responses',
    };
  }

  env.AGM_API_KEY = apiKey;
  env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  if (opencodeMajor === 1) {
    env.OPENCODE_CONFIG = path.join(home, 'opencode.json');
    await fs.writeFile(
      env.OPENCODE_CONFIG,
      JSON.stringify({
        provider: {
          agm: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Antigravity Manager',
            options: { baseURL: `${gateway}/v1`, apiKey: '{env:AGM_API_KEY}' },
            models: { [model]: { name: model, limit: { context: 200000, output: 8192 } } },
          },
        },
        model: `agm/${model}`,
        permission: { edit: 'allow', bash: 'deny' },
      }),
      { mode: 0o600 },
    );
    return {
      bin: bin ?? 'opencode',
      args: ['run', '--pure', '--auto', '--format', 'json', '--model', `agm/${model}`, taskPrompt],
      env,
      protocol: 'openai',
    };
  }

  const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(configDir, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: `agm/${model}`,
      update: 'disable',
      providers: {
        agm: {
          name: 'Antigravity Manager',
          env: ['AGM_API_KEY'],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `${gateway}/v1` },
          models: { [model]: { name: model } },
        },
      },
      permissions: [
        { action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' },
        { action: 'webfetch', resource: '*', effect: 'deny' },
        { action: 'websearch', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'execute', resource: '*', effect: 'allow' },
      ],
    }),
    { mode: 0o600 },
  );
  return {
    bin: bin ?? 'opencode',
    args: ['run', '--standalone', '--format', 'json', '--model', `agm/${model}`, taskPrompt],
    env,
    protocol: 'openai',
  };
}
