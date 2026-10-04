import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { AgentToolError } from './agent-tools.schema';

const settings = z
  .object({
    env: z.record(z.string(), z.unknown()).optional(),
    model: z.string().optional(),
  })
  .passthrough();
const ownedEnv = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

export function readClaudeSettings(source: string) {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  const result = settings.safeParse(value);
  if (errors.length || !result.success) {
    throw new AgentToolError('invalid-config');
  }
  return result.data;
}

function set(source: string, path: string[], value: unknown): string {
  return applyEdits(
    source,
    modify(source, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  );
}

export function configureClaude(
  source: string,
  baseUrl: string,
  model: string,
  key: string,
): string {
  readClaudeSettings(source);
  let next = set(source, ['model'], model);
  for (const name of ownedEnv) {
    const value =
      name === 'ANTHROPIC_BASE_URL'
        ? baseUrl
        : name === 'ANTHROPIC_API_KEY'
          ? key
          : name.includes('DEFAULT_')
            ? model
            : undefined;
    next = set(next, ['env', name], value);
  }
  readClaudeSettings(next);
  return next;
}

/** Only connection/model fields are restored; unrelated settings added later survive removal. */
export function removeClaudeConnection(source: string, original: string | null): string {
  readClaudeSettings(source);
  const previous = readClaudeSettings(original ?? '{}');
  let next = set(source, ['model'], previous.model);
  for (const name of ownedEnv) {
    next = set(next, ['env', name], previous.env?.[name]);
  }
  return next;
}
