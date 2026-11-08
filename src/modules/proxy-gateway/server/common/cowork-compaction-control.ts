import { randomUUID } from 'node:crypto';
import { Observable, of } from 'rxjs';
import type { AnthropicChatResponse } from './interfaces/request-interfaces';

const acknowledgements = new WeakSet<object>();

export function isCoworkLocalAcknowledgement(result: object): boolean {
  return acknowledgements.has(result);
}

export type CoworkControlOutcome =
  | { kind: 'trigger'; operationId: string; estimatedInputTokens: number; targetTokens: number }
  | { kind: 'acknowledgement'; operationId?: string; message: string };

/** A local client-control outcome must leave account retries before provider accounting. */
export class CoworkCompactionControl extends Error {
  constructor(public readonly outcome: CoworkControlOutcome) {
    super(
      outcome.kind === 'trigger'
        ? `prompt is too long: ${outcome.estimatedInputTokens} tokens > ${outcome.targetTokens} maximum`
        : outcome.message,
    );
    this.name = 'CoworkCompactionControl';
  }
}

export function coworkLocalAcknowledgement(
  model: string,
  message: string,
  stream: boolean,
): AnthropicChatResponse | Observable<string> {
  const response: AnthropicChatResponse = {
    id: `msg_local_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: message }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (!stream) {
    acknowledgements.add(response);
    return response;
  }
  const event = (type: string, value: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  const result = of(
    event('message_start', { message: { ...response, content: [], stop_reason: null } }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: message } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
    event('message_stop', {}),
  );
  acknowledgements.add(result);
  return result;
}
