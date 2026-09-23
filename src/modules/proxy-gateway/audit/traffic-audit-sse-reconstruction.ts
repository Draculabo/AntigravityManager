import { auditJsonObject, type AuditJsonObject } from './audit-json-object';

type JsonObject = AuditJsonObject;

const knownResponsesEventTypes = new Set([
  'error',
  'response.audio.delta',
  'response.audio.done',
  'response.audio.transcript.delta',
  'response.audio.transcript.done',
  'response.completed',
  'response.content_part.added',
  'response.content_part.done',
  'response.created',
  'response.failed',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.in_progress',
  'response.incomplete',
  'response.mcp_call.arguments.delta',
  'response.mcp_call.arguments.done',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'response.mcp_call.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.annotation.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.queued',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.refusal.delta',
  'response.refusal.done',
]);

export function reconstructAuditSseResponse(events: unknown[]): JsonObject {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = auditJsonObject(events[index]);
    if (event?.type === 'response.completed' && auditJsonObject(event.response)) {
      return withUnrecognized(event.response, events, isKnownResponsesEvent);
    }
  }
  if (events.some((event) => String(auditJsonObject(event)?.type ?? '').startsWith('message_'))) {
    return reconstructAnthropicMessage(events);
  }
  if (events.some((event) => Array.isArray(auditJsonObject(event)?.choices))) {
    return reconstructOpenAiChat(events);
  }
  if (events.some((event) => geminiEventBody(auditJsonObject(event)) !== null)) {
    return reconstructGeminiResponse(events);
  }
  return { events };
}

function reconstructOpenAiChat(events: unknown[]): JsonObject {
  const response: JsonObject = { choices: [], object: 'chat.completion' };
  const choices = new Map<number, JsonObject>();
  for (const value of events) {
    const event = auditJsonObject(value);
    if (!event) {
      continue;
    }
    for (const key of ['id', 'created', 'model', 'system_fingerprint'] as const) {
      if (event[key] !== undefined) {
        response[key] = event[key];
      }
    }
    if (auditJsonObject(event.usage)) {
      response.usage = event.usage;
    }
    for (const rawChoice of Array.isArray(event.choices) ? event.choices : []) {
      const choice = auditJsonObject(rawChoice);
      if (!choice) {
        continue;
      }
      const index = typeof choice.index === 'number' ? choice.index : choices.size;
      const current = choices.get(index) ?? { index, message: { role: 'assistant' } };
      const message = auditJsonObject(current.message) ?? { role: 'assistant' };
      const delta = auditJsonObject(choice.delta) ?? auditJsonObject(choice.message);
      if (delta) {
        mergeText(message, delta, 'content');
        mergeText(message, delta, 'reasoning_content');
        mergeText(message, delta, 'refusal');
        if (typeof delta.role === 'string') {
          message.role = delta.role;
        }
        mergeToolCalls(message, delta);
      }
      current.message = message;
      if (choice.finish_reason !== undefined) {
        current.finish_reason = choice.finish_reason;
      }
      choices.set(index, current);
    }
  }
  response.choices = [...choices.values()].sort(
    (left, right) => Number(left.index) - Number(right.index),
  );
  return withUnrecognized(response, events, (event) => Array.isArray(event.choices));
}

function reconstructAnthropicMessage(events: unknown[]): JsonObject {
  const message: JsonObject = { content: [], role: 'assistant', type: 'message' };
  const blocks = new Map<number, JsonObject>();
  for (const value of events) {
    const event = auditJsonObject(value);
    if (!event) {
      continue;
    }
    const started = auditJsonObject(event.message);
    if (event.type === 'message_start' && started) {
      Object.assign(message, started, { content: [] });
    }
    const index = typeof event.index === 'number' ? event.index : null;
    if (event.type === 'content_block_start' && index !== null) {
      blocks.set(index, { ...(auditJsonObject(event.content_block) ?? {}) });
    }
    if (event.type === 'content_block_delta' && index !== null) {
      const block = blocks.get(index) ?? {};
      const delta = auditJsonObject(event.delta);
      if (delta) {
        mergeText(block, delta, 'text');
        mergeText(block, delta, 'thinking');
        mergeText(block, delta, 'partial_json', 'input');
        if (typeof delta.signature === 'string') {
          block.signature = delta.signature;
        }
      }
      blocks.set(index, block);
    }
    if (event.type === 'content_block_stop' && index !== null) {
      const block = blocks.get(index);
      if (block && typeof block.input === 'string') {
        try {
          block.input = JSON.parse(block.input);
        } catch {
          // Preserve the partial tool JSON for diagnostics.
        }
      }
    }
    if (event.type === 'message_delta') {
      Object.assign(message, auditJsonObject(event.delta) ?? {});
      const usage = auditJsonObject(event.usage);
      if (usage) {
        message.usage = { ...(auditJsonObject(message.usage) ?? {}), ...usage };
      }
    }
  }
  message.content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  return withUnrecognized(message, events, (event) =>
    [
      'message_start',
      'message_delta',
      'message_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'ping',
      'error',
    ].includes(String(event.type ?? '')),
  );
}

function reconstructGeminiResponse(events: unknown[]): JsonObject {
  const response: JsonObject = {};
  const envelope: JsonObject = {};
  const candidates = new Map<number, JsonObject>();
  let wrapped = false;
  for (const value of events) {
    const event = auditJsonObject(value);
    if (!event) {
      continue;
    }
    const eventBody = geminiEventBody(event);
    if (!eventBody) {
      continue;
    }
    if (eventBody !== event) {
      wrapped = true;
      for (const [key, entry] of Object.entries(event)) {
        if (key !== 'response') {
          envelope[key] = entry;
        }
      }
    }
    for (const key of ['modelVersion', 'responseId', 'usageMetadata', 'promptFeedback'] as const) {
      if (eventBody[key] !== undefined) {
        response[key] = eventBody[key];
      }
    }
    for (const rawCandidate of Array.isArray(eventBody.candidates) ? eventBody.candidates : []) {
      const candidate = auditJsonObject(rawCandidate);
      if (!candidate) {
        continue;
      }
      const index = typeof candidate.index === 'number' ? candidate.index : candidates.size;
      const current = candidates.get(index) ?? { index };
      const content = auditJsonObject(candidate.content);
      if (content) {
        const existing = auditJsonObject(current.content) ?? {};
        const parts = Array.isArray(existing.parts) ? existing.parts : [];
        current.content = {
          ...existing,
          ...content,
          parts: [...parts, ...(Array.isArray(content.parts) ? content.parts : [])],
        };
      }
      for (const key of ['finishReason', 'safetyRatings', 'citationMetadata'] as const) {
        if (candidate[key] !== undefined) {
          current[key] = candidate[key];
        }
      }
      candidates.set(index, current);
    }
  }
  response.candidates = [...candidates.values()].sort(
    (left, right) => Number(left.index) - Number(right.index),
  );
  const reconstructed = wrapped ? { ...envelope, response } : response;
  return withUnrecognized(reconstructed, events, (event) => geminiEventBody(event) !== null);
}

function geminiEventBody(event: JsonObject | null): JsonObject | null {
  if (!event) {
    return null;
  }
  if (Array.isArray(event.candidates)) {
    return event;
  }
  const wrapped = auditJsonObject(event.response);
  return wrapped && Array.isArray(wrapped.candidates) ? wrapped : null;
}

function isKnownResponsesEvent(event: JsonObject): boolean {
  return knownResponsesEventTypes.has(String(event.type ?? ''));
}

function withUnrecognized(
  responseValue: unknown,
  events: unknown[],
  isKnown: (event: JsonObject) => boolean,
): JsonObject {
  const response = auditJsonObject(responseValue) ?? { response: responseValue };
  const unrecognized = events.filter((value) => {
    const event = auditJsonObject(value);
    return !event || !isKnown(event);
  });
  if (unrecognized.length > 0) {
    response._unrecognized_events = unrecognized;
  }
  return response;
}

function mergeText(
  target: JsonObject,
  source: JsonObject,
  sourceKey: string,
  targetKey = sourceKey,
) {
  const chunk = source[sourceKey];
  if (typeof chunk === 'string') {
    target[targetKey] = `${typeof target[targetKey] === 'string' ? target[targetKey] : ''}${chunk}`;
  }
}

function mergeToolCalls(message: JsonObject, delta: JsonObject): void {
  if (!Array.isArray(delta.tool_calls)) {
    return;
  }
  const current: JsonObject[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const value of message.tool_calls) {
      const existing = auditJsonObject(value);
      if (existing) {
        current.push(existing);
      }
    }
  }
  for (const raw of delta.tool_calls) {
    const call = auditJsonObject(raw);
    if (!call) {
      continue;
    }
    const index = typeof call.index === 'number' ? call.index : current.length;
    const merged = current[index] ?? {};
    const functionValue = auditJsonObject(merged.function) ?? {};
    Object.assign(merged, call);
    const next = auditJsonObject(call.function);
    if (next) {
      mergeText(functionValue, next, 'arguments');
      if (typeof next.name === 'string') {
        functionValue.name = next.name;
      }
      merged.function = functionValue;
    }
    current[index] = merged;
  }
  message.tool_calls = current;
}
