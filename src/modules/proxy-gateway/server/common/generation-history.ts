import { BadRequestException } from '@nestjs/common';
import { recordPromptTransformation } from './prompt-transformation-diagnostics';
import type {
  AnthropicMessage,
  GeminiContent,
  OpenAIMessage,
} from './interfaces/request-interfaces';

type HistoryFailure =
  | 'empty-input'
  | 'unsupported-assistant-start'
  | 'missing-tool-results'
  | 'unsupported-prefill'
  | 'invalid-role';
export class InvalidGenerationHistoryError extends BadRequestException {
  constructor(readonly reason: HistoryFailure) {
    super(`Invalid generation history: ${reason}.`);
  }
}
interface Turn {
  role: string;
  present: boolean;
  input: boolean;
  prefill: boolean;
  calls: number;
  results: number;
}

/** Identity validators own call/result association; this owner checks generation completeness. */
function assertHistory(turns: Iterable<Turn>): void {
  let hasInput = false;
  let first = true;
  let pending = 0;
  let last: Turn | undefined;
  for (const turn of turns) {
    if (turn.role === 'system' || turn.role === 'developer' || !turn.present) {
      continue;
    }
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      throw new InvalidGenerationHistoryError('invalid-role');
    }
    if (first && turn.role === 'assistant' && turn.calls === 0) {
      throw new InvalidGenerationHistoryError('unsupported-assistant-start');
    }
    first = false;
    if (
      (turn.calls > 0 && turn.role !== 'assistant') ||
      (turn.results > 0 && turn.role !== 'user')
    ) {
      throw new InvalidGenerationHistoryError('invalid-role');
    }
    hasInput ||= turn.input;
    pending += turn.calls - turn.results;
    last = turn;
  }
  if (!hasInput) {
    throw new InvalidGenerationHistoryError('empty-input');
  }
  if (pending !== 0) {
    throw new InvalidGenerationHistoryError('missing-tool-results');
  }
  if (last?.role === 'assistant' && !last.prefill) {
    throw new InvalidGenerationHistoryError('unsupported-prefill');
  }
}

export function assertOpenAIGenerationHistory(messages: readonly OpenAIMessage[]): void {
  assertHistory(
    (function* () {
      let started = false;
      for (const message of messages) {
        const system = message.role === 'system' || message.role === 'developer';
        const role = system
          ? started
            ? 'user'
            : 'system'
          : message.role === 'tool'
            ? 'user'
            : message.role;
        started ||= !system;
        const text =
          typeof message.content === 'string'
            ? message.content.trim().length > 0
            : (message.content?.some(
                (part) => part.type === 'text' && Boolean(part.text?.trim()),
              ) ?? false);
        const media =
          Array.isArray(message.content) && message.content.some((part) => part.type !== 'text');
        const calls = message.tool_calls?.length ?? 0;
        const results = message.role === 'tool' ? 1 : 0;
        const input = text || media || calls > 0 || results > 0;
        yield { role, input, present: input, prefill: text, calls, results };
      }
    })(),
  );
}

export function assertAnthropicGenerationHistory(messages: readonly AnthropicMessage[]): void {
  assertHistory(
    (function* () {
      let started = false;
      for (const message of messages) {
        const system = message.role === 'system' || message.role === 'developer';
        const role = system ? (started ? 'user' : 'system') : message.role;
        started ||= !system;
        let text = typeof message.content === 'string' && message.content.trim().length > 0;
        let present = text;
        let media = false;
        let calls = 0;
        let results = 0;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text') {
              text ||= block.text.trim().length > 0;
            } else if (block.type === 'tool_use') {
              calls++;
            } else if (block.type === 'tool_result') {
              results++;
            } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
              present = true;
            } else {
              media = true;
            }
          }
        }
        const input = text || media || calls > 0 || results > 0;
        yield { role, input, present: present || input, prefill: text, calls, results };
      }
    })(),
  );
}

export function assertGeminiGenerationHistory(contents: readonly GeminiContent[]): void {
  assertHistory(
    (function* () {
      for (const content of contents) {
        if (content.role !== 'user' && content.role !== 'model') {
          throw new InvalidGenerationHistoryError('invalid-role');
        }
        let text = false;
        let present = false;
        let media = false;
        let calls = 0;
        let results = 0;
        for (const part of content.parts) {
          text ||= part.thought !== true && Boolean(part.text?.trim());
          present ||=
            part.thought === true ||
            part.thoughtSignature !== undefined ||
            part.thought_signature !== undefined;
          media ||= Boolean(part.inlineData || part.fileData);
          calls += part.functionCall ? 1 : 0;
          results += part.functionResponse ? 1 : 0;
        }
        const input = text || media || calls > 0 || results > 0;
        yield {
          role: content.role === 'model' ? 'assistant' : content.role,
          input,
          present: present || input,
          prefill: text,
          calls,
          results,
        };
      }
    })(),
  );
}

/** Temporary outbound copy only. Counting requests do not call this generation-tail adapter. */
export function prepareGoogleGenerationContents(
  contents: readonly GeminiContent[],
  model: string,
): GeminiContent[] {
  const output: GeminiContent[] = [];
  for (const [message, content] of contents.entries()) {
    const signedHistory =
      content.role === 'model' &&
      content.parts.some(
        (part) =>
          part.thoughtSignature !== undefined ||
          part.thought_signature !== undefined ||
          part.thought === true,
      );
    const parts = content.parts.filter((part, partIndex) => {
      const keep =
        signedHistory ||
        part.text === undefined ||
        part.text.trim() !== '' ||
        part.thought === true ||
        part.thoughtSignature !== undefined ||
        part.thought_signature !== undefined ||
        part.functionCall ||
        part.functionResponse ||
        part.inlineData ||
        part.fileData;
      if (!keep) {
        recordPromptTransformation({
          kind: 'empty-text-removed',
          surface: 'contents',
          message,
          part: partIndex,
        });
      }
      return keep;
    });
    if (parts.length > 0) {
      output.push({ ...content, parts: parts.map((part) => ({ ...part })) });
    }
  }
  const last = output.at(-1);
  const physicalModel = model.split('/').at(-1)?.toLowerCase() ?? '';
  const requiresUserEnding =
    physicalModel.startsWith('gemini-') && !physicalModel.includes('image');
  if (
    requiresUserEnding &&
    last?.role === 'model' &&
    last.parts.some((part) => part.thought !== true && Boolean(part.text?.trim())) &&
    !last.parts.some((part) => part.functionCall)
  ) {
    recordPromptTransformation({
      kind: 'prefill-tail-appended',
      surface: 'contents',
      message: output.length,
      part: null,
    });
    output.push({ role: 'user', parts: [{ text: '.' }] });
  }
  return output;
}
