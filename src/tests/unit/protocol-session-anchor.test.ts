import { describe, expect, it } from 'vitest';
import {
  resolveAnthropicSessionScope,
  resolveGeminiSessionScope,
  resolveOpenAISessionScope,
} from '@/server/gateway/common/signature-session-scope';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const fn = { name: 'read', description: 'Read a file', parameters: schema };
const chat: OpenAIChatRequest = {
  model: 'gemini-pro-agent',
  messages: [
    { role: 'system', content: 'Read only.' },
    { role: 'user', content: 'Task A' },
  ],
  tools: [{ type: 'function', function: fn }],
};
const messages: AnthropicChatRequest = {
  model: chat.model,
  system: [{ type: 'text', text: 'Read only.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Task A' }] }],
  tools: [{ name: fn.name, description: fn.description, input_schema: schema }],
};
const gemini: GeminiRequest = {
  systemInstruction: { parts: [{ text: 'Read only.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Task A' }] }],
  tools: [{ functionDeclarations: [fn] }],
};
const headers = { authorization: 'Bearer synthetic-tenant', 'x-session-id': 'synthetic-session' };

describe('protocol session anchors', () => {
  it('unifies logical identity for equivalent text and functions without sharing protocol signatures', () => {
    const scopes = [
      resolveOpenAISessionScope(chat, headers),
      resolveAnthropicSessionScope(messages, headers),
      resolveGeminiSessionScope(gemini, headers),
    ];
    expect(new Set(scopes.map((scope) => scope.storeKey)).size).toBe(1);
    expect(new Set(scopes.map((scope) => scope.affinityKey)).size).toBe(1);
    expect(new Set(scopes.map((scope) => scope.cacheKey)).size).toBe(3);
    const anonymous = [
      resolveOpenAISessionScope(chat),
      resolveAnthropicSessionScope(messages),
      resolveGeminiSessionScope(gemini),
    ];
    expect(new Set(anonymous.map((scope) => scope.storeKey)).size).toBe(1);
    expect(anonymous.map((scope) => scope.affinityKey)).toEqual(
      anonymous.map((scope) => scope.storeKey),
    );
  });
  it('retains full function schemas, descriptions and initial instruction roles', () => {
    const baseline = resolveOpenAISessionScope(chat, headers);
    for (const functionValue of [
      { ...fn, description: 'Delete a file' },
      { ...fn, parameters: { type: 'string' } },
    ]) {
      const changed = resolveOpenAISessionScope(
        { ...chat, tools: [{ type: 'function', function: functionValue }] },
        headers,
      );
      expect(changed.affinityKey).toBe(baseline.affinityKey);
      expect(changed.storeKey).not.toBe(baseline.storeKey);
      expect(changed.cacheKey).not.toBe(baseline.cacheKey);
    }
    expect(
      resolveOpenAISessionScope(
        { ...chat, messages: [{ role: 'developer', content: 'Read only.' }, chat.messages[1]] },
        headers,
      ).storeKey,
    ).not.toBe(baseline.storeKey);
    expect(
      resolveAnthropicSessionScope(
        { ...messages, tools: [{ name: fn.name, description: 'Changed', input_schema: schema }] },
        headers,
      ).storeKey,
    ).not.toBe(baseline.storeKey);
    expect(
      resolveGeminiSessionScope(
        {
          ...gemini,
          tools: [{ functionDeclarations: [{ ...fn, parameters: { type: 'string' } }] }],
        },
        headers,
      ).storeKey,
    ).not.toBe(baseline.storeKey);
  });
  it('preserves initial instructions across appended turns and tool-only preambles', () => {
    const baseline = resolveGeminiSessionScope(gemini);
    expect(
      resolveGeminiSessionScope({
        ...gemini,
        contents: [
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'read', response: { result: 'old' } } }],
          },
          ...gemini.contents,
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'Continue' }] },
        ],
      }),
    ).toEqual(baseline);
    expect(
      resolveAnthropicSessionScope({
        ...messages,
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old' }] },
          ...messages.messages,
        ],
      }),
    ).toEqual(resolveAnthropicSessionScope(messages));
  });
  it('does not merge media, named messages, built-in or unknown function extensions', () => {
    const scope = resolveOpenAISessionScope(chat, headers);
    const variants: OpenAIChatRequest[] = [
      { ...chat, messages: [chat.messages[0], { ...chat.messages[1], name: 'different-author' }] },
      {
        ...chat,
        messages: [
          chat.messages[0],
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: 'https://example.invalid/image' }],
          },
        ],
      },
      { ...chat, tools: [{ type: 'function', function: fn, strict: true }] },
    ];
    for (const request of variants) {
      expect(resolveOpenAISessionScope(request, headers).storeKey).not.toBe(scope.storeKey);
    }
    expect(
      resolveGeminiSessionScope({ ...gemini, tools: [{ googleSearch: {} }] }, headers).storeKey,
    ).not.toBe(scope.storeKey);
  });
  it('preserves key-order equivalence and separates tenants and empty requests', () => {
    const reordered = {
      required: ['path'],
      properties: { path: { type: 'string' } },
      type: 'object',
    };
    expect(
      resolveOpenAISessionScope(
        { ...chat, tools: [{ type: 'function', function: { ...fn, parameters: reordered } }] },
        headers,
      ),
    ).toEqual(resolveOpenAISessionScope(chat, headers));
    expect(
      resolveGeminiSessionScope(gemini, { ...headers, authorization: 'Bearer other' }).storeKey,
    ).not.toBe(resolveGeminiSessionScope(gemini, headers).storeKey);
    expect(resolveGeminiSessionScope({ contents: [] }).storeKey).not.toBe(
      resolveGeminiSessionScope({ contents: [] }).storeKey,
    );
  });
});
