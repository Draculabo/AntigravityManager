import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import { recordPromptTransformation } from '../../../common/prompt-transformation-diagnostics';

export const HERMES_PROMPT_HEADER = 'x-antigravity-hermes-prompt';
const COMPACT_SYSTEM_PROMPT = 'Answer briefly.';
// The named provider can also send auxiliary requests with their own system instructions.
const HERMES_SYSTEM_OPENING =
  /^You are Hermes(?: Agent)?, (?:built by Nous Research\.|an (?:intelligent )?AI assistant created by Nous Research\.)/u;

export function applyHermesCompactPrompt(
  request: OpenAIChatRequest,
  mode: string | string[] | undefined,
): OpenAIChatRequest {
  if (mode !== 'compact' || !Array.isArray(request.messages)) {
    return request;
  }

  const first = request.messages[0];
  if (
    first?.role !== 'system' ||
    typeof first.content !== 'string' ||
    !HERMES_SYSTEM_OPENING.test(first.content)
  ) {
    return request;
  }

  recordPromptTransformation({
    kind: 'hermes-system-compacted',
    surface: 'messages',
    message: 0,
    part: null,
  });
  return {
    ...request,
    messages: [{ ...first, content: COMPACT_SYSTEM_PROMPT }, ...request.messages.slice(1)],
  };
}
