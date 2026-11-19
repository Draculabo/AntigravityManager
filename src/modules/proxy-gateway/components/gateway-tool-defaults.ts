import type {
  ConnectionProfileSaveInput,
  ConnectionProfileView,
} from '../connection-profiles/connection-profiles.schema';

export const gatewayToolNames: Record<ConnectionProfileView['client'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  dsh: 'DSH',
  'kimi-code': 'Kimi Code',
  'qwen-code': 'Qwen Code',
  'gemini-cli': 'Gemini CLI',
  pi: 'Pi',
};

export function gatewayToolOptions(client: ConnectionProfileView['client']) {
  const protocol =
    client === 'claude'
      ? 'anthropic-messages'
      : client === 'codex'
        ? 'openai-responses'
        : client === 'gemini-cli'
          ? 'gemini-native'
          : 'openai-completions';
  return {
    client,
    protocol,
    sdk: client === 'opencode' ? '@ai-sdk/openai-compatible' : null,
    version: client === 'openclaw' ? 'v2' : null,
    discoverModels: client === 'hermes',
    dshProfile: client === 'dsh' ? 'web' : null,
  } satisfies Partial<ConnectionProfileSaveInput>;
}
