import type { PlaygroundExecuteInput } from './playground.schema';

/** Shared by execution and cURL export so a reproduction preserves the submitted parameters. */
export function buildPlaygroundRequest(input: PlaygroundExecuteInput) {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (input.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: input.systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: input.prompt });
  return {
    model: input.model,
    messages,
    stream: false,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.reasoningEffort === 'off'
      ? { thinking: { type: 'disabled', budget_tokens: 0 } }
      : input.reasoningEffort && input.reasoningEffort !== 'default'
        ? {
            reasoning_effort: input.reasoningEffort,
            thinking: { type: 'enabled', effort: input.reasoningEffort },
          }
        : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPlaygroundCurl(
  input: PlaygroundExecuteInput,
  baseUrl: string,
  accountId?: string,
): string {
  const args = [
    `curl ${shellQuote(`${baseUrl}/v1/chat/completions`)}`,
    `  -H 'Content-Type: application/json'`,
    `  -H 'Authorization: Bearer YOUR_API_KEY'`,
  ];
  const target = accountId || input.accountId?.trim();
  if (target) {
    args.push(`  -H ${shellQuote(`x-antigravity-account-id: ${target}`)}`);
  }
  args.push(`  -d ${shellQuote(JSON.stringify(buildPlaygroundRequest(input)))}`);
  return args.join(' \\\n');
}
