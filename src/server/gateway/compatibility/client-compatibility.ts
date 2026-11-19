import type { OpenAIChatRequest } from '../common/interfaces/request-interfaces';
import { applyHermesCompactPrompt } from './hermes-compact-prompt';

export { normalizeSystemPrompt } from './system-text-rules';

export const HERMES_PROMPT_HEADER = 'x-antigravity-hermes-prompt';

interface ChatCompatibilityOptions {
  compactHermesPrompt: boolean;
}

type ChatRequestRule = (
  request: OpenAIChatRequest,
  options: ChatCompatibilityOptions,
) => OpenAIChatRequest;

const chatRequestRules: readonly ChatRequestRule[] = [
  (request, { compactHermesPrompt }) =>
    compactHermesPrompt ? applyHermesCompactPrompt(request) : request,
];

/** Applies Chat compatibility before the request is mapped or sent upstream. */
export function prepareClientChatRequest(
  request: OpenAIChatRequest,
  options: ChatCompatibilityOptions,
): OpenAIChatRequest {
  return chatRequestRules.reduce((current, rule) => rule(current, options), request);
}
