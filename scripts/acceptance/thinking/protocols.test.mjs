import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateThinking,
  followUpRequest,
  initialRequest,
  inspectResponse,
} from './protocols.mjs';

test('signed Anthropic thinking survives the tool continuation unchanged', () => {
  const content = [
    { type: 'thinking', thinking: 'Synthetic reasoning', signature: 'synthetic-signature' },
    { type: 'tool_use', id: 'call-1', name: 'lookup_number', input: {} },
  ];
  const first = inspectResponse('anthropic', { content });
  const initial = initialRequest('anthropic', 'test-model');
  assert.deepEqual(followUpRequest('anthropic', initial, first), {
    ...initial.body,
    messages: [
      ...initial.body.messages,
      { role: 'assistant', content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"number":17}' }],
      },
    ],
  });
});

test('Gemini thought signatures and parts survive the tool continuation unchanged', () => {
  const content = {
    role: 'model',
    parts: [
      { text: 'Synthetic reasoning', thought: true, thoughtSignature: 'synthetic-signature' },
      {
        functionCall: { name: 'lookup_number', args: {} },
        thoughtSignature: 'synthetic-tool-signature',
      },
    ],
  };
  const first = inspectResponse('gemini', { candidates: [{ content }] });
  const initial = initialRequest('gemini', 'test-model');
  assert.deepEqual(followUpRequest('gemini', initial, first), {
    ...initial.body,
    contents: [
      ...initial.body.contents,
      content,
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'lookup_number', response: { number: 17 } } }],
      },
    ],
  });
});

test('OpenAI reasoning and tool IDs survive the tool continuation unchanged', () => {
  const message = {
    role: 'assistant',
    content: null,
    reasoning_content: 'Synthetic reasoning',
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'lookup_number', arguments: '{}' } },
    ],
  };
  const first = inspectResponse('openai', { choices: [{ message }] });
  const initial = initialRequest('openai', 'test-model');
  assert.deepEqual(followUpRequest('openai', initial, first), {
    ...initial.body,
    messages: [
      ...initial.body.messages,
      message,
      { role: 'tool', tool_call_id: 'call-1', content: '{"number":17}' },
    ],
  });
});

const successful = {
  responses: [
    { calls: [{ name: 'lookup_number' }], thoughtBytes: 12, text: '' },
    { calls: [], thoughtBytes: 8, text: '391' },
  ],
  audit: [0, 1].map(() => ({
    request: { status: 200, responsePartial: false, outcome: 'completed', reasoningTokens: null },
  })),
  writeFailuresDelta: 0,
  workerAlive: true,
};
test('correct output plus complete audit and observable thinking passes without invented token usage', () => {
  assert.deepEqual(evaluateThinking(successful), { passed: true, failures: [] });
});
test('HTTP 200 alone cannot hide missing thinking, partial output or an incorrect answer', () => {
  assert.deepEqual(
    evaluateThinking({
      ...successful,
      responses: [
        { calls: [{}], thoughtBytes: 0, text: '' },
        { calls: [], thoughtBytes: 0, text: '392' },
      ],
      audit: successful.audit.map((item) => ({
        request: { ...item.request, responsePartial: true },
      })),
    }),
    {
      passed: false,
      failures: [
        'incorrect-final-answer',
        'audit-status-or-completion-mismatch',
        'reasoning-evidence-unavailable',
      ],
    },
  );
});
test('unknown tools fail before a fabricated tool result can be sent', () => {
  assert.throws(
    () =>
      followUpRequest('openai', initialRequest('openai', 'test-model'), {
        calls: [{ name: 'other_tool', args: {} }],
        history: {},
      }),
    /Unexpected tool/,
  );
});
