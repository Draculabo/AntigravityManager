import type { ClaudeRequest, GeminiToolConfig } from './types';

/** Preserve tool selection when either client protocol crosses the Gemini boundary. */
export function buildToolConfig(toolChoice: ClaudeRequest['tool_choice']): GeminiToolConfig {
  const choice = typeof toolChoice === 'string' ? toolChoice : toolChoice?.type;
  let mode = 'VALIDATED';
  if (choice !== undefined) {
    switch (choice) {
      case 'auto':
        mode = 'AUTO';
        break;
      case 'none':
        mode = 'NONE';
        break;
      default:
        mode = 'ANY';
    }
  }
  let name: string | undefined;
  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'tool') {
      name = toolChoice.name;
    } else if (toolChoice.type === 'function') {
      name = toolChoice.function?.name;
    }
  }

  return {
    functionCallingConfig: {
      mode,
      ...(name ? { allowedFunctionNames: [name] } : {}),
    },
    includeServerSideToolInvocations: true,
  };
}
