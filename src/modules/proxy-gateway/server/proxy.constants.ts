/**
 * Default body limit for Fastify JSON requests to model conversation,
 * prompt completion, token counting, and batch routes (64 MiB).
 *
 * Sized to comfortably fit long LLM conversation histories with multi-turn
 * tool outputs, as well as multimodal requests containing up to 32 MiB decoded
 * inline Base64 media plus conversational context, without allowing unbounded
 * payload memory consumption.
 */
export const DEFAULT_PROXY_JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Predicate to identify routes that accept large model conversation, prompt,
 * batch, or diagnostic payloads. Non-model routes keep Fastify's safe 1 MiB
 * ceiling to prevent memory amplification and unauthenticated DoS.
 */
export function isModelPayloadRoute(url: string): boolean {
  return (
    url === '/v1/chat/completions' ||
    url === '/v1/completions' ||
    url === '/v1/complete' ||
    url === '/v1/messages' ||
    url === '/v1/messages/count_tokens' ||
    url === '/v1/responses' ||
    url === '/v1/batches' ||
    url === '/v1/messages/batches' ||
    url.startsWith('/v1beta/models/') ||
    url.startsWith('/v1internal/')
  );
}
