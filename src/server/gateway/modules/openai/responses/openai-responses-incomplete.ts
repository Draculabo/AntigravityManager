/**
 * A Responses answer that upstream cut short is not a finished answer. The OpenAI
 * Responses API reports that with `status: "incomplete"` plus a reason, so a client
 * can tell "the model stopped" from "the budget ran out" and decide whether to
 * continue. Both mappers on this surface already receive the upstream finish reason,
 * which arrives either in Gemini spelling (`MAX_TOKENS`) or in OpenAI spelling
 * (`length`) depending on which path produced it.
 *
 * Only the budget case is mapped here. A safety block is also `incomplete` in the
 * upstream API, but this gateway already gives it a shape of its own: the response
 * stays `completed` and carries a `refusal` content part, which is pinned by
 * `openai-responses-response-mapper.test.ts`. Rewriting that is a behavior decision
 * about the refusal shape, not the truncation fix, so it is left alone.
 */
export type ResponsesOutputStatus = 'completed' | 'incomplete';

const TRUNCATED_BY_BUDGET = new Set(['MAX_TOKENS', 'LENGTH']);

export function toIncompleteReason(finishReason: string | null | undefined): string | null {
  const normalized = finishReason?.toUpperCase();
  if (normalized && TRUNCATED_BY_BUDGET.has(normalized)) {
    return 'max_output_tokens';
  }
  return null;
}
