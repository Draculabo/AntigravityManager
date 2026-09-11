import { afterEach, describe, expect, it } from 'vitest';

import { vi } from 'vitest';

import {
  transformClaudeRequestIn,
  getPlaceholderSignatureUsageCount,
  resetPlaceholderSignatureUsageCount,
} from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

const THOUGHT_SIGNATURE = 'thought-signature-for-tool-call';
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const SIGNATURE_MODEL = 'gemini-3-flash';

describe('thought signature compatibility', () => {
  afterEach(() => {
    SignatureStore.clear();
    resetPlaceholderSignatureUsageCount();
  });

  it('sends both signature field names for thinking, function calls, and tool results', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should call the tool.', signature: THOUGHT_SIGNATURE },
            {
              type: 'tool_use',
              id: 'call_weather',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_weather',
              content: 'Cloudy',
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const [thinkingPart, functionCallPart] = body.request.contents[0].parts;
    const [functionResponsePart] = body.request.contents[1].parts;

    for (const part of [thinkingPart, functionCallPart, functionResponsePart]) {
      expect(part.thoughtSignature).toBe(THOUGHT_SIGNATURE);
      expect(part.thought_signature).toBe(THOUGHT_SIGNATURE);
    }
  });

  it('concatenates only text blocks from an array tool result', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_structured_result',
              content: [
                { type: 'text', text: 'first line' },
                { type: 'thinking', thinking: 'ignore this block' },
                { type: 'text', text: 'second line' },
              ],
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);

    expect(body.request.contents[0]?.parts).toEqual([
      {
        functionResponse: {
          name: 'call_structured_result',
          response: { result: 'first line\nsecond line' },
          id: 'call_structured_result',
        },
      },
    ]);
  });

  it('keeps gemini-pro-agent thinking enabled and injects both sentinel signature fields', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3.1-pro-high',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_without_signature',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);

    expect(body.model).toBe('gemini-pro-agent');
    expect(body.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 256,
    });
    expect(body.request.contents[0].parts).toEqual([
      {
        text: 'Thinking...',
        thought: true,
      },
      {
        functionCall: {
          name: 'get_weather',
          args: { location: 'London' },
          id: 'call_without_signature',
        },
        thoughtSignature: SKIP_THOUGHT_SIGNATURE,
        thought_signature: SKIP_THOUGHT_SIGNATURE,
      },
    ]);
    expect(getPlaceholderSignatureUsageCount()).toBe(1);
  });

  it.each(['gemini-3.5-flash-high', 'gemini-3.6-flash', 'gemini-3.7-flash'])(
    'injects both sentinel signature fields for unsigned %s tool history without thinking',
    (model) => {
      const request: ClaudeRequest = {
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `call_${model}`,
                name: 'get_weather',
                input: { location: 'London' },
              },
            ],
          },
        ],
      };

      const body = transformClaudeRequestIn(request);
      const functionCallPart = body.request.contents[0].parts.find((part) => part.functionCall);

      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
      expect(functionCallPart?.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
      expect(functionCallPart?.thought_signature).toBe(SKIP_THOUGHT_SIGNATURE);
    },
  );

  it('does not inject a sentinel signature for an unsigned non-Flash tool call', () => {
    const request: ClaudeRequest = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_unsigned_pro',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const functionCallPart = body.request.contents[0].parts.find((part) => part.functionCall);

    expect(functionCallPart?.thoughtSignature).toBeUndefined();
    expect(functionCallPart?.thought_signature).toBeUndefined();
  });

  it('accepts snake-case signatures from non-streaming Gemini responses', () => {
    const response = transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { location: 'London' },
                    id: 'call_weather',
                  },
                  thought_signature: THOUGHT_SIGNATURE,
                },
              ],
            },
          },
        ],
      },
      {
        model: SIGNATURE_MODEL,
        signatureSessionKey: 'anthropic:non-stream-session',
        signatureMessageCount: 2,
      },
    );

    expect(response.content).toContainEqual({
      type: 'tool_use',
      id: 'call_weather',
      name: 'get_weather',
      input: { location: 'London' },
      signature: THOUGHT_SIGNATURE,
    });
    expect(
      SignatureStore.getAt({
        model: SIGNATURE_MODEL,
        sessionKey: 'anthropic:non-stream-session',
        messageCount: 2,
      }),
    ).toBe(THOUGHT_SIGNATURE);
  });

  it('accepts snake-case signatures from streaming Gemini responses', () => {
    const state = new StreamingState();
    const processor = new PartProcessor(state);
    const chunks = processor.process({
      text: 'Reasoning',
      thought: true,
      thought_signature: THOUGHT_SIGNATURE,
    });
    chunks.push(...state.emitFinish('STOP', {}));

    expect(chunks.join('')).toContain(THOUGHT_SIGNATURE);
  });

  it('reuses only the signature belonging to the request session', () => {
    const alphaSignature = 'thought-signature-for-session-alpha';
    SignatureStore.store({
      signature: alphaSignature,
      model: SIGNATURE_MODEL,
      sessionKey: 'anthropic:session-alpha',
    });
    SignatureStore.store({
      signature: 'thought-signature-for-session-beta',
      model: SIGNATURE_MODEL,
      sessionKey: 'anthropic:session-beta',
    });

    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      metadata: { signature_session_key: 'anthropic:session-alpha' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_session_alpha',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const functionCallPart = body.request.contents[0].parts.find((part) => part.functionCall);

    expect(functionCallPart?.thoughtSignature).toBe(alphaSignature);
    expect(functionCallPart?.thought_signature).toBe(alphaSignature);
  });

  it('stores signatures by message count and removes future entries after rewind', () => {
    const sessionKey = 'anthropic:rewind-session';
    const firstSignature = 'a'.repeat(60);
    const shorterFirstSignature = 'b'.repeat(55);
    const futureSignature = 'c'.repeat(70);
    const rewindSignature = 'd'.repeat(65);

    SignatureStore.store({
      signature: firstSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 1,
    });
    SignatureStore.store({
      signature: shorterFirstSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 1,
    });
    SignatureStore.store({
      signature: futureSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 3,
    });

    expect(SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 1 })).toBe(
      firstSignature,
    );
    expect(SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 3 })).toBe(
      futureSignature,
    );
    expect(SignatureStore.get({ model: SIGNATURE_MODEL, sessionKey })).toBe(futureSignature);

    SignatureStore.store({
      signature: rewindSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 2,
    });

    expect(SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 1 })).toBe(
      firstSignature,
    );
    expect(SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 2 })).toBe(
      rewindSignature,
    );
    expect(
      SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 3 }),
    ).toBeNull();
    expect(SignatureStore.get({ model: SIGNATURE_MODEL, sessionKey })).toBe(rewindSignature);
  });

  it('replays the signature matching each historical message index before the latest fallback', () => {
    const sessionKey = 'anthropic:multi-turn-session';
    const firstTurnSignature = 'first-turn-signature'.repeat(4);
    const latestTurnSignature = 'latest-turn-signature'.repeat(4);

    SignatureStore.store({
      signature: firstTurnSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 1,
    });
    SignatureStore.store({
      signature: latestTurnSignature,
      model: SIGNATURE_MODEL,
      sessionKey,
      messageCount: 3,
    });

    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      metadata: { signature_session_key: sessionKey },
      messages: [
        { role: 'user', content: 'First request' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_first_turn',
              name: 'first_tool',
              input: {},
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_first_turn', content: 'Done' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_latest_turn',
              name: 'latest_tool',
              input: {},
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const firstTurnCall = body.request.contents[1].parts.find((part) => part.functionCall);
    const latestTurnCall = body.request.contents[3].parts.find((part) => part.functionCall);

    expect(firstTurnCall?.thoughtSignature).toBe(firstTurnSignature);
    expect(latestTurnCall?.thoughtSignature).toBe(latestTurnSignature);
  });

  it('stores a streamed tool signature at the request message count', () => {
    const sessionKey = 'anthropic:stream-message-count';
    const state = new StreamingState({ model: SIGNATURE_MODEL, sessionKey, messageCount: 5 });
    const processor = new PartProcessor(state);

    processor.process({
      functionCall: {
        id: 'call_streamed',
        name: 'streamed_tool',
        args: {},
      },
      thoughtSignature: THOUGHT_SIGNATURE,
    });

    expect(SignatureStore.getAt({ model: SIGNATURE_MODEL, sessionKey, messageCount: 5 })).toBe(
      THOUGHT_SIGNATURE,
    );
  });

  it("keeps concurrent tool calls in the same turn from reading each other's signature", () => {
    const sessionKey = 'anthropic:parallel-tool-calls';

    // Two tool calls produced in the same assistant turn (same message count), each with
    // its own signature. The longer one is what the legacy session+messageCount bucket
    // would keep, so a fallback keyed only by that bucket would replay it for both calls.
    const shortCallSignature = 'sig-for-call-a-' + 'x'.repeat(20);
    const longCallSignature = 'sig-for-call-b-' + 'y'.repeat(60);

    transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'tool_a', args: {}, id: 'call_a' },
                  thoughtSignature: shortCallSignature,
                },
                {
                  functionCall: { name: 'tool_b', args: {}, id: 'call_b' },
                  thoughtSignature: longCallSignature,
                },
              ],
            },
          },
        ],
      },
      { model: SIGNATURE_MODEL, signatureSessionKey: sessionKey, signatureMessageCount: 9 },
    );

    expect(
      SignatureStore.getForToolCall({ model: SIGNATURE_MODEL, toolCallId: 'call_a', sessionKey }),
    ).toBe(shortCallSignature);
    expect(
      SignatureStore.getForToolCall({ model: SIGNATURE_MODEL, toolCallId: 'call_b', sessionKey }),
    ).toBe(longCallSignature);

    // Replay: a client that echoes tool_use blocks back without their signature must
    // still get each call's own signature, not the other call's.
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      metadata: { signature_session_key: sessionKey },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'tool_a', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'tool_b', input: {} },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const functionCallParts = body.request.contents[0].parts.filter((part) => part.functionCall);

    expect(functionCallParts[0]?.thoughtSignature).toBe(shortCallSignature);
    expect(functionCallParts[1]?.thoughtSignature).toBe(longCallSignature);
  });

  it('returns null instead of throwing when no signature was ever stored for a tool-call id', () => {
    expect(() =>
      SignatureStore.getForToolCall({ model: SIGNATURE_MODEL, toolCallId: 'never-stored-call-id' }),
    ).not.toThrow();
    expect(
      SignatureStore.getForToolCall({ model: SIGNATURE_MODEL, toolCallId: 'never-stored-call-id' }),
    ).toBeNull();
    expect(
      SignatureStore.getForToolCall({ model: SIGNATURE_MODEL, toolCallId: undefined }),
    ).toBeNull();
  });

  it('isolates identical tool-call ids between sessions and clears only the requested session', () => {
    const toolCallId = 'reused-call-id';
    SignatureStore.store({
      signature: 'signature-alpha',
      model: SIGNATURE_MODEL,
      sessionKey: 'anthropic:session-alpha',
      messageCount: 1,
      toolCallId,
    });
    SignatureStore.store({
      signature: 'signature-beta-is-longer',
      model: SIGNATURE_MODEL,
      sessionKey: 'anthropic:session-beta',
      messageCount: 1,
      toolCallId,
    });

    expect(
      SignatureStore.getForToolCall({
        model: SIGNATURE_MODEL,
        toolCallId,
        sessionKey: 'anthropic:session-alpha',
      }),
    ).toBe('signature-alpha');
    expect(
      SignatureStore.getForToolCall({
        model: SIGNATURE_MODEL,
        toolCallId,
        sessionKey: 'anthropic:session-beta',
      }),
    ).toBe('signature-beta-is-longer');

    SignatureStore.clear('anthropic:session-alpha');

    expect(
      SignatureStore.getForToolCall({
        model: SIGNATURE_MODEL,
        toolCallId,
        sessionKey: 'anthropic:session-alpha',
      }),
    ).toBeNull();
    expect(
      SignatureStore.getForToolCall({
        model: SIGNATURE_MODEL,
        toolCallId,
        sessionKey: 'anthropic:session-beta',
      }),
    ).toBe('signature-beta-is-longer');
  });

  it('reuses provenance within a canonical family and rejects another family', () => {
    SignatureStore.store({
      signature: THOUGHT_SIGNATURE,
      model: 'gemini-3-flash-agent',
      family: 'gemini-3.5-flash',
      familyModel: 'gemini-3-flash-agent',
      sessionKey: 'family-session',
    });

    expect(
      SignatureStore.get({ model: 'gemini-3.5-flash-low', sessionKey: 'family-session' }),
    ).toBe(THOUGHT_SIGNATURE);
    expect(
      SignatureStore.get({ model: 'gemini-3.7-flash-low', sessionKey: 'family-session' }),
    ).toBeNull();
  });

  it('does not replay a signature from the pre-mapper family after web-search remaps the physical model', () => {
    const sessionKey = 'anthropic:web-search-remap';
    SignatureStore.store({
      signature: THOUGHT_SIGNATURE,
      model: 'gpt-oss-120b-medium',
      family: 'gpt-oss-120b-medium',
      familyModel: 'gpt-oss-120b-medium',
      sessionKey,
      toolCallId: 'call_weather',
    });

    const body = transformClaudeRequestIn(
      {
        model: 'gpt-oss-120b-medium',
        thinking: { type: 'enabled', budget_tokens: 256 },
        metadata: { signature_session_key: sessionKey },
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_weather',
                name: 'get_weather',
                input: { location: 'London' },
              },
            ],
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
      undefined,
      undefined,
      'gpt-oss-120b-medium',
      'anthropic',
      {
        signatureTargetFamily: 'gpt-oss-120b-medium',
        signatureTargetFamilyModel: 'gpt-oss-120b-medium',
      },
    );
    const functionCallPart = body.request.contents[0]?.parts.find((part) => part.functionCall);

    expect(body.model).toBe('gemini-3-flash');
    expect(functionCallPart?.thoughtSignature).not.toBe(THOUGHT_SIGNATURE);
  });

  it('stores a remapped response under its actual physical model instead of the stale account family', () => {
    const sessionKey = 'anthropic:remapped-response';
    transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'get_weather', args: {}, id: 'call_weather' },
                  thoughtSignature: THOUGHT_SIGNATURE,
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gemini-3-flash',
        family: 'gpt-oss-120b-medium',
        familyModel: 'gpt-oss-120b-medium',
        signatureSessionKey: sessionKey,
      },
    );

    expect(
      SignatureStore.get({ model: 'gpt-oss-120b-medium', sessionKey }),
    ).toBeNull();
    expect(SignatureStore.get({ model: 'gemini-3-flash', sessionKey })).toBe(THOUGHT_SIGNATURE);
  });

  it('matches unknown models only by exact normalized physical id', () => {
    SignatureStore.store({
      signature: THOUGHT_SIGNATURE,
      model: ' Vendor-Physical-Model ',
      sessionKey: 'unknown-session',
    });

    expect(
      SignatureStore.get({ model: 'vendor-physical-model', sessionKey: 'unknown-session' }),
    ).toBe(THOUGHT_SIGNATURE);
    expect(
      SignatureStore.get({ model: 'vendor-other-model', sessionKey: 'unknown-session' }),
    ).toBeNull();
  });

  it('treats provenance-less entries as misses and skips producers without a model', () => {
    (SignatureStore as unknown as { signature: unknown }).signature = {
      signature: THOUGHT_SIGNATURE,
      updatedAt: Date.now(),
    };
    expect(SignatureStore.get({ model: SIGNATURE_MODEL })).toBeNull();

    SignatureStore.store({ signature: THOUGHT_SIGNATURE, model: '   ' });
    expect(SignatureStore.get({ model: SIGNATURE_MODEL })).toBeNull();
  });

  it('clears only the failed recovery scope', () => {
    SignatureStore.store({ signature: 'legacy-signature', model: SIGNATURE_MODEL });
    SignatureStore.store({
      signature: 'named-signature',
      model: SIGNATURE_MODEL,
      sessionKey: 'named-session',
    });

    SignatureStore.clearRecoveryScope();

    expect(SignatureStore.get({ model: SIGNATURE_MODEL })).toBeNull();
    expect(SignatureStore.get({ model: SIGNATURE_MODEL, sessionKey: 'named-session' })).toBe(
      'named-signature',
    );
  });

  it('recovery mapping never reads cache but preserves explicit tool signatures and sentinel logic', () => {
    const getSpy = vi.spyOn(SignatureStore, 'get');
    const getAtSpy = vi.spyOn(SignatureStore, 'getAt');
    const getToolSpy = vi.spyOn(SignatureStore, 'getForToolCall');
    const body = transformClaudeRequestIn(
      {
        model: 'gemini-3-flash',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'explicit',
                name: 'one',
                input: {},
                signature: 'client-signature',
              },
              { type: 'tool_use', id: 'unsigned', name: 'two', input: {} },
            ],
          },
        ],
      },
      undefined,
      undefined,
      undefined,
      'anthropic',
      { mode: 'invalid-thought-signature-recovery' },
    );

    expect(getSpy).not.toHaveBeenCalled();
    expect(getAtSpy).not.toHaveBeenCalled();
    expect(getToolSpy).not.toHaveBeenCalled();
    const functionCallParts = body.request.contents[0]?.parts.filter((part) => part.functionCall);
    expect(functionCallParts?.[0]?.thoughtSignature).toBe('client-signature');
    expect(functionCallParts?.[1]?.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });
});
