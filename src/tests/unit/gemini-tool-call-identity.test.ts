import { describe, expect, it, vi } from 'vitest';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import type { GeminiRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { normalizeGeminiToolCallIds } from '@/server/gateway/modules/gemini/gemini-tool-call-identity';

function createRequest(contents: unknown[]): GeminiRequest {
  return { contents } as unknown as GeminiRequest;
}

describe('native Gemini tool-call identity', () => {
  it('repairs unknown result names by explicit pending IDs across parallel calls and reused IDs', () => {
    const request: GeminiRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'a', name: 'read', args: { path: '/a' } } },
            { functionCall: { id: 'b', name: 'write', args: { path: '/b' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'b',
                name: 'unknown',
                response: { error: 'permission denied', nested: { count: 0 } },
              },
            },
            { functionResponse: { id: 'a', name: 'unknown', response: { result: 'file' } } },
          ],
        },
        { role: 'model', parts: [{ functionCall: { id: 'a', name: 'write', args: {} } }] },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'a', name: 'unknown', response: { result: 'saved' } } },
          ],
        },
      ],
    };
    const before = structuredClone(request);
    const expected = structuredClone(request);
    expected.contents[1] = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'b',
            name: 'write',
            response: { error: 'permission denied', nested: { count: 0 } },
          },
        },
        { functionResponse: { id: 'a', name: 'read', response: { result: 'file' } } },
      ],
    };
    expected.contents[3] = {
      role: 'user',
      parts: [{ functionResponse: { id: 'a', name: 'write', response: { result: 'saved' } } }],
    };
    expect(normalizeGeminiToolCallIds(request)).toEqual(expected);
    expect(request).toEqual(before);
    expect(normalizeGeminiToolCallIds(expected)).toBe(expected);
  });

  it.each([undefined, 'orphan'])(
    'does not infer an unknown result name from the most recent call, id=%s',
    (id) => {
      const request = createRequest([
        { role: 'model', parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }] },
        {
          role: 'user',
          parts: [{ functionResponse: { id, name: 'unknown', response: { result: 'file' } } }],
        },
      ]);
      expect(() => normalizeGeminiToolCallIds(request)).toThrow(InvalidToolResultAssociationError);
    },
  );

  it.each([undefined, 'call-explicit'])(
    'rejects a conflicting result name even with one pending call, id=%s',
    (id) => {
      const request = createRequest([
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call-explicit', name: 'read', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { ...(id ? { id } : {}), name: 'write', response: { ok: true } } },
          ],
        },
      ]);
      const original = structuredClone(request);
      expect(() => normalizeGeminiToolCallIds(request)).toThrow(
        expect.objectContaining({
          reason: 'conflicting-result-name',
        }),
      );
      expect(request).toEqual(original);
    },
  );

  it('generates distinct stable IDs for parallel calls without changing the caller request', () => {
    const request = createRequest([
      { role: 'user', parts: [{ text: 'Read both files.' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read', args: { path: '/a' } } },
          { functionCall: { name: 'read', args: { path: '/a' } } },
        ],
      },
    ]);

    const normalized = normalizeGeminiToolCallIds(request);
    const replay = normalizeGeminiToolCallIds(request);
    const firstIds = normalized.contents[1]?.parts.map((part) => part.functionCall?.id);
    const changedHistory = normalizeGeminiToolCallIds(
      createRequest([
        { role: 'user', parts: [{ text: 'Read a different pair of files.' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'read', args: { path: '/a' } } },
            { functionCall: { name: 'read', args: { path: '/a' } } },
          ],
        },
      ]),
    );

    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);
    expect(replay.contents[1]?.parts.map((part) => part.functionCall?.id)).toEqual(firstIds);
    expect(changedHistory.contents[1]?.parts[0]?.functionCall?.id).not.toBe(firstIds?.[0]);
    expect(request.contents[1]?.parts[0]?.functionCall).not.toHaveProperty('id');
  });

  it('copies a missing response ID from exactly one pending call and preserves explicit IDs', () => {
    const request = createRequest([
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call-explicit', name: 'read', args: { path: '/a' } } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { content: 'file' } } }],
      },
    ]);

    const normalized = normalizeGeminiToolCallIds(request);

    expect(normalized.contents[0]?.parts[0]?.functionCall?.id).toBe('call-explicit');
    expect(normalized.contents[1]?.parts[0]?.functionResponse?.id).toBe('call-explicit');
    expect(request.contents[1]?.parts[0]?.functionResponse).not.toHaveProperty('id');
  });

  it('preserves complete results and permits an ID to name another function only after consumption', () => {
    const request = createRequest([
      {
        role: 'model',
        parts: [{ functionCall: { id: 'reused', name: 'read', args: { path: '/a' } } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'reused',
              name: 'read',
              response: { result: 'file', nested: { count: 1 } },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { id: 'reused', name: 'write', args: { path: '/b' } } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'reused',
              name: 'write',
              response: { error: 'permission denied' },
            },
          },
        ],
      },
    ]);
    const original = structuredClone(request);
    expect(normalizeGeminiToolCallIds(request)).toBe(request);
    expect(request).toEqual(original);
  });

  it.each([false, true])(
    'rejects a mismatched result name before leasing, stream=%s',
    async (stream) => {
      const accountLease = { getNextToken: vi.fn() };
      const geminiClient = { generateInternal: vi.fn(), streamGenerateInternal: vi.fn() };
      const service = new GeminiService(
        accountLease as never,
        geminiClient as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const request = createRequest([
        { role: 'model', parts: [{ functionCall: { id: 'first', name: 'read', args: {} } }] },
        {
          role: 'user',
          parts: [{ functionResponse: { id: 'first', name: 'write', response: { ok: true } } }],
        },
      ]);
      await expect(
        stream
          ? service.handleGeminiStreamGenerateContent('models/gemini-2.5-flash', request)
          : service.handleGeminiGenerateContent('models/gemini-2.5-flash', request),
      ).rejects.toMatchObject({ reason: 'conflicting-result-name' });
      expect(accountLease.getNextToken).not.toHaveBeenCalled();
      expect(geminiClient.generateInternal).not.toHaveBeenCalled();
      expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
    },
  );

  it('rejects ambiguous, orphan, and duplicate pending associations', () => {
    const ambiguous = createRequest([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read', args: { path: '/a' } } },
          { functionCall: { name: 'write', args: { path: '/b' } } },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { ok: true } } }],
      },
    ]);
    const orphan = createRequest([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { ok: true } } }],
      },
    ]);
    const duplicate = createRequest([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'same', name: 'read', args: {} } },
          { functionCall: { id: 'same', name: 'write', args: {} } },
        ],
      },
    ]);

    expect(() => normalizeGeminiToolCallIds(ambiguous)).toThrow(
      expect.objectContaining<Partial<InvalidToolResultAssociationError>>({
        reason: 'ambiguous-missing-id',
      }),
    );
    expect(() => normalizeGeminiToolCallIds(orphan)).toThrow(
      expect.objectContaining<Partial<InvalidToolResultAssociationError>>({
        reason: 'missing-pending-call',
      }),
    );
    expect(() => normalizeGeminiToolCallIds(duplicate)).toThrow(
      expect.objectContaining<Partial<InvalidToolResultAssociationError>>({
        reason: 'duplicate-pending-id',
      }),
    );
  });

  it('rejects an ambiguous history before account selection and upstream dispatch', async () => {
    const accountLease = { getNextToken: vi.fn() };
    const geminiClient = { generateInternal: vi.fn(), streamGenerateInternal: vi.fn() };
    const service = new GeminiService(
      accountLease as never,
      geminiClient as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = createRequest([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read', args: {} } },
          { functionCall: { name: 'write', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { ok: true } } }],
      },
    ]);

    await expect(
      service.handleGeminiGenerateContent('models/gemini-2.5-flash', request),
    ).rejects.toBeInstanceOf(InvalidToolResultAssociationError);
    await expect(
      service.handleGeminiStreamGenerateContent('models/gemini-2.5-flash', request),
    ).rejects.toBeInstanceOf(InvalidToolResultAssociationError);
    expect(accountLease.getNextToken).not.toHaveBeenCalled();
    expect(geminiClient.generateInternal).not.toHaveBeenCalled();
    expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
  });
});
