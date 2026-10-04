import assert from 'node:assert/strict';
import { z } from 'zod';

const prompt =
  'First call lookup_number exactly once. After its result, multiply the returned number by 23. Reply with only the product. Do not guess the tool result.';
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false };
const tool = {
  name: 'lookup_number',
  description: 'Retrieve the number for this calculation.',
  parameters,
};
const textPart = z
  .object({ text: z.string().optional(), thought: z.boolean().optional() })
  .passthrough();
const call = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).passthrough(),
  })
  .passthrough();
const chatSchema = z.object({
  choices: z.array(
    z.object({
      message: z
        .object({
          role: z.literal('assistant'),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().optional(),
          tool_calls: z.array(call).optional(),
        })
        .passthrough(),
    }),
  ),
});
const anthropicSchema = z.object({
  content: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        thinking: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.object({}).strict().optional(),
      })
      .passthrough(),
  ),
});
const geminiSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        role: z.string(),
        parts: z.array(
          textPart.extend({
            functionCall: z.object({ name: z.string(), args: z.object({}).strict() }).optional(),
          }),
        ),
      }),
    }),
  ),
});

export function initialRequest(protocol, model) {
  switch (protocol) {
    case 'openai':
      return {
        route: '/v1/chat/completions',
        body: {
          model,
          max_tokens: 4096,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'function', function: tool }],
          tool_choice: 'auto',
        },
      };
    case 'anthropic':
      return {
        route: '/v1/messages',
        body: {
          model,
          max_tokens: 4096,
          thinking: { type: 'enabled', budget_tokens: 2048 },
          messages: [{ role: 'user', content: prompt }],
          tools: [{ name: tool.name, description: tool.description, input_schema: parameters }],
        },
      };
    case 'gemini':
      return {
        route: `/v1beta/models/${model}:generateContent`,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ functionDeclarations: [tool] }],
          generationConfig: {
            maxOutputTokens: 4096,
            thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
          },
        },
      };
    default:
      throw new Error('Unsupported thinking protocol');
  }
}

export function inspectResponse(protocol, body) {
  switch (protocol) {
    case 'openai': {
      const message = chatSchema.parse(body).choices[0]?.message;
      assert(message, 'Missing chat response');
      return {
        text: message.content ?? '',
        thoughtBlocks: message.reasoning_content ? 1 : 0,
        thoughtBytes: Buffer.byteLength(message.reasoning_content ?? ''),
        calls: (message.tool_calls ?? []).map((item) => ({
          id: item.id,
          name: item.function.name,
          args: JSON.parse(item.function.arguments),
        })),
        history: message,
      };
    }
    case 'anthropic': {
      const parts = anthropicSchema.parse(body).content;
      return {
        text: parts
          .filter((item) => item.type === 'text')
          .map((item) => item.text ?? '')
          .join(''),
        thoughtBlocks: parts.filter((item) => item.type === 'thinking').length,
        thoughtBytes: parts.reduce((sum, item) => sum + Buffer.byteLength(item.thinking ?? ''), 0),
        calls: parts
          .filter((item) => item.type === 'tool_use')
          .map((item) => ({ id: item.id, name: item.name, args: item.input })),
        history: parts,
      };
    }
    case 'gemini': {
      const content = geminiSchema.parse(body).candidates[0]?.content;
      assert(content, 'Missing Gemini response');
      return {
        text: content.parts
          .filter((item) => !item.thought)
          .map((item) => item.text ?? '')
          .join(''),
        thoughtBlocks: content.parts.filter((item) => item.thought).length,
        thoughtBytes: content.parts
          .filter((item) => item.thought)
          .reduce((sum, item) => sum + Buffer.byteLength(item.text ?? ''), 0),
        calls: content.parts
          .filter((item) => item.functionCall)
          .map((item) => ({ name: item.functionCall.name, args: item.functionCall.args })),
        history: content,
      };
    }
    default:
      throw new Error('Unsupported thinking protocol');
  }
}

export function followUpRequest(protocol, initial, first) {
  assert.equal(first.calls.length, 1, 'Expected exactly one lookup tool call');
  assert.equal(first.calls[0].name, tool.name, 'Unexpected tool');
  assert.deepEqual(first.calls[0].args, {}, 'Lookup takes no arguments');
  switch (protocol) {
    case 'openai':
      return {
        ...initial.body,
        messages: [
          ...initial.body.messages,
          first.history,
          { role: 'tool', tool_call_id: first.calls[0].id, content: '{"number":17}' },
        ],
      };
    case 'anthropic':
      return {
        ...initial.body,
        messages: [
          ...initial.body.messages,
          { role: 'assistant', content: first.history },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: first.calls[0].id, content: '{"number":17}' },
            ],
          },
        ],
      };
    case 'gemini':
      return {
        ...initial.body,
        contents: [
          ...initial.body.contents,
          first.history,
          {
            role: 'user',
            parts: [{ functionResponse: { name: tool.name, response: { number: 17 } } }],
          },
        ],
      };
    default:
      throw new Error('Unsupported thinking protocol');
  }
}

export function evaluateThinking({ responses, audit, writeFailuresDelta, workerAlive }) {
  const failures = [];
  if (
    responses.length !== 2 ||
    responses[0]?.calls.length !== 1 ||
    responses[1]?.calls.length !== 0
  ) {
    failures.push('tool-round-trip-incomplete');
  }
  if (responses[1]?.text.trim() !== '391') {
    failures.push('incorrect-final-answer');
  }
  if (
    audit.length !== 2 ||
    audit.some(
      (item) =>
        item.request.status !== 200 ||
        item.request.responsePartial ||
        item.request.outcome !== 'completed',
    )
  ) {
    failures.push('audit-status-or-completion-mismatch');
  }
  if (
    responses.every((item) => item.thoughtBytes === 0) &&
    audit.every((item) => !(item.request.reasoningTokens > 0))
  ) {
    failures.push('reasoning-evidence-unavailable');
  }
  if (!workerAlive || writeFailuresDelta !== 0) {
    failures.push('thought-store-unhealthy');
  }
  return { passed: failures.length === 0, failures };
}
