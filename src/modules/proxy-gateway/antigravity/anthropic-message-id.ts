import { v4 as uuidv4 } from 'uuid';

/**
 * An Anthropic client expects a message id it can recognise: the API spec gives
 * every resource its own prefix, and this gateway already honours that everywhere
 * else it mints one (`resp_` on the Responses surface). Messages had fallen out of
 * it and handed back the provider's raw identifier instead.
 *
 * The prefix is applied idempotently, so an upstream id that already carries it is
 * passed through untouched, and a response that arrives without one gets a unique
 * id rather than a shared constant.
 */
export const ANTHROPIC_MESSAGE_ID_PREFIX = 'msg_';

export function toAnthropicMessageId(responseId?: string | null): string {
  const upstream = typeof responseId === 'string' ? responseId.trim() : '';
  if (upstream.startsWith(ANTHROPIC_MESSAGE_ID_PREFIX)) {
    return upstream;
  }

  return `${ANTHROPIC_MESSAGE_ID_PREFIX}${upstream || uuidv4()}`;
}
