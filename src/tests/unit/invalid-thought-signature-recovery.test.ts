import { describe, expect, it } from 'vitest';

import {
  INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT,
  rewriteInvalidThoughtSignatureRequest,
} from '@/modules/proxy-gateway/antigravity/thought-signature-recovery';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { classifyInvalidThoughtSignatureError } from '@/modules/proxy-gateway/server/modules/anthropic/invalid-thought-signature-error';

describe('invalid thought signature classifier', () => {
  it.each([
    ['Invalid thought signature.', 'message'],
    ['INVALID THOUGHT SIGNATURE', 'message'],
    ['thinking.signature: field required', 'message'],
    ['thoughtSignature is corrupted', 'message'],
  ])('classifies narrow 400 text %s', (message, source) => {
    expect(
      classifyInvalidThoughtSignatureError(new UpstreamRequestError({ message, status: 400 })),
    ).toEqual({ source });
  });

  it('prefers explicit structured detail over message and body', () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Invalid thought signature.',
      body: '{"error":{"message":"thought_signature missing"}}',
      details: [{ reason: 'THOUGHT_SIGNATURE_INVALID' }],
    });
    expect(classifyInvalidThoughtSignatureError(error)).toEqual({ source: 'structured_detail' });
  });

  it('classifies parsed bodies before the narrow text fallback', () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Bad request',
      body: '{"error":{"field":"thinking.signature","reason":"required"}}',
    });
    expect(classifyInvalidThoughtSignatureError(error)).toEqual({ source: 'parsed_body' });
  });

  it.each([
    'invalid signature',
    'failed to deserialise',
    'thinking block',
    'found `text`',
    'must be `thinking`',
    'thinking.thinking: field required',
    'INVALID_ARGUMENT',
  ])('rejects broad false positive %s', (message) => {
    expect(
      classifyInvalidThoughtSignatureError(new UpstreamRequestError({ message, status: 400 })),
    ).toBeNull();
  });

  it('rejects matching text for every non-400 status and non-upstream error', () => {
    expect(
      classifyInvalidThoughtSignatureError(
        new UpstreamRequestError({ message: 'Invalid thought signature.', status: 500 }),
      ),
    ).toBeNull();
    expect(
      classifyInvalidThoughtSignatureError(new Error('Invalid thought signature.')),
    ).toBeNull();
  });
});

describe('invalid thought signature history rewrite', () => {
  it('clones, preserves context, converts thinking, drops redacted thinking, and appends once', () => {
    const request: ClaudeRequest = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'reasoning',
              signature: 'bad',
              cache_control: { type: 'ephemeral' },
            },
            { type: 'thinking', thinking: '', signature: 'bad-empty' },
            { type: 'redacted_thinking', data: 'secret' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'lookup',
              input: {},
              signature: 'explicit-tool-signature',
            },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    };

    const recovered = rewriteInvalidThoughtSignatureRequest(request);
    const repeated = rewriteInvalidThoughtSignatureRequest(recovered);

    expect(request.messages[0]?.content).toHaveLength(4);
    expect(recovered.thinking).toEqual(request.thinking);
    expect(recovered.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reasoning' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'lookup',
            input: {},
            signature: 'explicit-tool-signature',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '[Tool call was interrupted by user.]' }],
      },
      { role: 'user', content: `continue${INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT}` },
    ]);
    expect(JSON.stringify(repeated).match(/\[System Recovery\]/g)).toHaveLength(1);
  });

  it('closes a broken active tool loop with the required message pair', () => {
    const recovered = rewriteInvalidThoughtSignatureRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
        },
      ],
    });
    expect(recovered.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '[System: Tool execution completed. Proceeding to final response.]',
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please provide the final result based on the tool output above.' },
        ],
      },
    ]);
  });

  it('appends one separate recovery text block to a final user block array', () => {
    const recovered = rewriteInvalidThoughtSignatureRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    });

    expect(recovered.messages[0]?.content).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: INVALID_THOUGHT_SIGNATURE_RECOVERY_PROMPT },
    ]);
  });

  it('does not add synthetic turns when the tool loop is already closed', () => {
    const recovered = rewriteInvalidThoughtSignatureRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
      ],
    });
    expect(recovered.messages).toHaveLength(3);
  });
});
