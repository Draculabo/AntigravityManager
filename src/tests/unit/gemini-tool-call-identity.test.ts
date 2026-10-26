import { describe, expect, it, vi } from 'vitest';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import type { GeminiRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { normalizeGeminiToolCallIds } from '@/modules/proxy-gateway/server/modules/gemini/gemini-tool-call-identity';

function createRequest(contents: unknown[]): GeminiRequest {
  return { contents } as unknown as GeminiRequest;
}

describe('native Gemini tool-call identity', () => {
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
