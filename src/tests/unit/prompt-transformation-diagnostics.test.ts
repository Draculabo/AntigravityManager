import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  recordPromptTransformation,
  snapshotPromptTransformations,
} from '@/modules/proxy-gateway/server/common/prompt-transformation-diagnostics';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { normalizeSystemPrompt } from '@/modules/proxy-gateway/antigravity/SystemPromptNormalization';
import { convertOpenAIToClaude } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-claude-conversion';
import { prepareGeminiRequestThoughtSignatures } from '@/modules/proxy-gateway/antigravity/thought-signature-format';
import { extractToolResultImages } from '@/modules/proxy-gateway/antigravity/MarkdownImageParts';

function context() {
  return {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'controlled',
    thoughtSessionStable: false,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded request-local transformation metadata', () => {
  it('records only bounded invalid-tool-image metadata and preserves the original text', () => {
    runWithTrafficAuditRequestContext(context(), () => {
      const text = 'data:image/png;base64,AQ==';
      for (let index = 0; index < 70; index += 1) {
        expect(extractToolResultImages(text)).toEqual({ text, media: [] });
      }
      expect(snapshotPromptTransformations()).toEqual({
        entries: Array.from({ length: 64 }, () => ({
          kind: 'tool-image-candidate-preserved',
          surface: 'messages',
          message: null,
          part: null,
        })),
        dropped: 6,
      });
    });
  });

  it('reports signature wrapping once at its exact part without retaining the signature', () => {
    const raw = Buffer.from([0x08, 0x04, 0x12, 0x01, 0x41]).toString('base64');
    const original = {
      model: 'claude-sonnet-4-6',
      requestId: 'controlled-signature-request',
      userAgent: 'controlled-signature-agent',
      request: {
        contents: [{ role: 'model', parts: [{ text: 'signed fixture', thought_signature: raw }] }],
      },
    };
    const wrapped: Array<{ message: number; part: number }> = [];
    const prepared = prepareGeminiRequestThoughtSignatures(original, (message, part) =>
      wrapped.push({ message, part }),
    );
    expect(prepared.request.contents[0].parts[0].thought_signature).toBe(
      Buffer.from(raw).toString('base64'),
    );
    expect(
      prepareGeminiRequestThoughtSignatures(prepared, (message, part) =>
        wrapped.push({ message, part }),
      ),
    ).toBe(prepared);
    expect(wrapped).toEqual([{ message: 0, part: 0 }]);
    expect(original.request.contents[0].parts[0].thought_signature).toBe(raw);
  });
  it('isolates interleaved requests and retains no process-global fallback', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runWithTrafficAuditRequestContext(context(), async () => {
      recordPromptTransformation({
        kind: 'initial-system-promoted',
        surface: 'messages',
        message: 1,
        part: null,
      });
      await waiting;
      return snapshotPromptTransformations();
    });
    const second = runWithTrafficAuditRequestContext(context(), () => {
      recordPromptTransformation({
        kind: 'late-system-reminder',
        surface: 'messages',
        message: 3,
        part: null,
      });
      return snapshotPromptTransformations();
    });
    release();
    expect(await first).toEqual({
      entries: [{ kind: 'initial-system-promoted', surface: 'messages', message: 1, part: null }],
      dropped: 0,
    });
    expect(second).toEqual({
      entries: [{ kind: 'late-system-reminder', surface: 'messages', message: 3, part: null }],
      dropped: 0,
    });
    recordPromptTransformation({
      kind: 'identity-normalized',
      surface: 'system',
      message: null,
      part: 0,
    });
    expect(snapshotPromptTransformations()).toEqual({ entries: [], dropped: 0 });
  });

  it('bounds retained events, reports overflow and returns independent snapshots', () => {
    runWithTrafficAuditRequestContext(context(), () => {
      for (let part = 0; part < 1000; part++) {
        recordPromptTransformation({
          kind: 'identity-normalized',
          surface: 'system',
          message: null,
          part,
        });
      }
      const first = snapshotPromptTransformations();
      expect(first).toEqual({
        entries: Array.from({ length: 64 }, (_, part) => ({
          kind: 'identity-normalized',
          surface: 'system',
          message: null,
          part,
        })),
        dropped: 936,
      });
      first.entries[0].part = 9999;
      first.entries.splice(1);
      expect(snapshotPromptTransformations().entries[0].part).toBe(0);
      expect(snapshotPromptTransformations().entries).toHaveLength(64);
      expect(Buffer.byteLength(JSON.stringify(snapshotPromptTransformations()))).toBeLessThan(
        12_000,
      );
    });
  });

  it('reports actual system transformations while protected and ordinary text remain unchanged', () => {
    const changes: string[] = [];
    const protectedText =
      '```\nx-anthropic-billing-header: example\nYou are an AI assistant built by Example.\n```';
    expect(normalizeSystemPrompt(protectedText, (kind) => changes.push(kind))).toBe(protectedText);
    expect(changes).toEqual([]);
    runWithTrafficAuditRequestContext(context(), () => {
      const chat = convertOpenAIToClaude({
        model: 'gemini-3-flash',
        messages: [
          { role: 'system', content: 'You are an AI assistant built by Example.' },
          { role: 'user', content: 'fixture user' },
          { role: 'system', content: 'late fixture reminder' },
        ],
      });
      transformClaudeRequestIn(chat, 'controlled-project', 'controlled-agent', 'gemini-3-flash');
      expect(snapshotPromptTransformations()).toEqual({
        entries: [
          { kind: 'initial-system-promoted', surface: 'messages', message: 0, part: null },
          { kind: 'late-system-reminder', surface: 'messages', message: 2, part: null },
          { kind: 'identity-normalized', surface: 'system', message: null, part: 0 },
        ],
        dropped: 0,
      });
    });
  });
});
