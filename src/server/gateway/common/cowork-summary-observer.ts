import { createHash } from 'node:crypto';
import { Observable, finalize, tap } from 'rxjs';
import { z } from 'zod';
import type { AnthropicChatResponse } from './interfaces/request-interfaces';
import { IncrementalSseLines } from './incremental-sse-lines';
import { inheritObservableFlowControl } from './observable-flow-control';
import { FlowControlledSseStream } from './flow-controlled-sse-stream';

const MAX_SUMMARY_CHARACTERS = 512 * 1024;
const SummaryEventSchema = z.object({
  type: z.string(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  content_block: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});

export interface ProviderSummaryProof {
  fingerprint: string;
  characters: number;
}

export function summaryTextFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function providerSummaryProof(text: string): ProviderSummaryProof | null {
  if (text.length > MAX_SUMMARY_CHARACTERS) {
    return null;
  }
  const tagged =
    /^\s*(?:<analysis>[\s\S]*?<\/analysis>\s*)?<summary>([\s\S]*?)<\/summary>\s*$/u.exec(text);
  const summary = (tagged?.[1] ?? text).trim();
  return summary ? { fingerprint: summaryTextFingerprint(summary), characters: summary.length } : null;
}

/** Observes the existing protocol result without replacing provider text, usage or errors. */
export function observeCoworkSummary(
  result: AnthropicChatResponse | Observable<string>,
  succeeded: (proof: ProviderSummaryProof) => void,
  failed: () => void,
): AnthropicChatResponse | Observable<string> {
  if (!(result instanceof Observable)) {
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const proof =
      result.stop_reason === 'end_turn' &&
      result.content.every(
        (block) =>
          block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking',
      )
        ? providerSummaryProof(text)
        : null;
    if (proof) {
      succeeded(proof);
    } else {
      failed();
    }
    return result;
  }
  const lines = new IncrementalSseLines(2 * MAX_SUMMARY_CHARACTERS);
  let text = '';
  let valid = true;
  let ended = false;
  let stopped = false;
  let completed = false;
  const observed = result.pipe(
    tap({
      next(chunk) {
        if (!valid) {
          return;
        }
        try {
          for (const line of lines.push(chunk)) {
            if (!line.startsWith('data:')) {
              continue;
            }
            const parsed = SummaryEventSchema.safeParse(JSON.parse(line.slice(5).trim()));
            if (!parsed.success) {
              valid = false;
              break;
            }
            const event = parsed.data;
            if (
              stopped ||
              event.type === 'error' ||
              (event.content_block &&
                !['text', 'thinking', 'redacted_thinking'].includes(event.content_block.type))
            ) {
              valid = false;
              break;
            }
            if (event.content_block?.type === 'text') {
              text += event.content_block.text ?? '';
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              text += event.delta.text ?? '';
            }
            if (text.length > MAX_SUMMARY_CHARACTERS) {
              valid = false;
              text = '';
              break;
            }
            if (event.type === 'message_delta') {
              ended = event.delta?.stop_reason === 'end_turn';
            }
            if (event.type === 'message_stop') {
              stopped = true;
            }
          }
        } catch {
          valid = false;
        }
      },
      complete() {
        const proof = valid && ended && stopped ? providerSummaryProof(text) : null;
        completed = proof !== null;
        if (proof) {
          succeeded(proof);
        }
      },
    }),
    finalize(() => {
      text = '';
      lines.clear();
      if (!completed) {
        failed();
      }
    }),
  );
  const output =
    result instanceof FlowControlledSseStream
      ? new FlowControlledSseStream(result, (subscriber) => observed.subscribe(subscriber))
      : observed;
  return inheritObservableFlowControl(result, output);
}
