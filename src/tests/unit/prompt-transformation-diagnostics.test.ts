import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  recordPromptTransformation,
  snapshotPromptTransformations,
} from '@/server/gateway/common/prompt-transformation-diagnostics';
import { buildAntigravityGenerationRequest } from '@/modules/proxy-gateway/antigravity/AntigravityRequestBuilder';
import { normalizeSystemPrompt } from '@/server/gateway/compatibility/client-compatibility';
import { toOpenAIGenerationInput } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
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
      const chat = toOpenAIGenerationInput({
        model: 'gemini-3-flash',
        messages: [
          { role: 'system', content: 'You are an AI assistant built by Example.' },
          { role: 'user', content: 'fixture user' },
          { role: 'system', content: 'late fixture reminder' },
        ],
      });
      buildAntigravityGenerationRequest(chat, {
        projectId: 'controlled-project',
        userAgent: 'controlled-agent',
        resolvedModel: 'gemini-3-flash',
      });
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

  it('normalizes the installed OpenCode opening on the outgoing tool request', () => {
    const opening =
      'You are opencode, an interactive CLI agent specializing in software engineering tasks.';
    const instruction = '\n\nUse the OpenAI SDK for this task.';
    const tool = {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: 'Read a documented OpenCode fixture.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    };
    const request = {
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: opening + instruction },
        { role: 'user', content: opening },
      ],
      tools: [tool],
    };
    const map = (content: string) =>
      buildAntigravityGenerationRequest(
        toOpenAIGenerationInput({
          ...request,
          messages: [{ role: 'system', content }, request.messages[1]],
        }),
        {
          projectId: 'controlled-project',
          userAgent: 'controlled-agent',
          resolvedModel: 'gemini-3-flash',
        },
      ).request;

    const neutral = map('You are an AI Agent.' + instruction);
    const actual = map(opening + instruction);
    expect(actual.systemInstruction).toEqual(neutral.systemInstruction);
    expect(actual.contents).toEqual(neutral.contents);
    expect(actual.contents[0].parts[0].text).toBe(opening);
    expect(actual.tools).toEqual(neutral.tools);
    expect(actual.tools?.[0].functionDeclarations?.[0].name).toBe('read_file');
  });

  it('recognizes the OpenCode CLI tool opening and preserves quotations and later references', () => {
    const opening =
      'You are OpenCode, an interactive CLI tool that helps users with software engineering tasks.';
    expect(normalizeSystemPrompt(opening + '\r\n\r\nKeep the exact instructions.')).toBe(
      'You are an AI Agent.\r\n\r\nKeep the exact instructions.',
    );
    for (const text of [
      '> ' + opening,
      '<example>\n' + opening + '\n</example>',
      'Explain this example.\n' + opening,
      'You are OpenCode, a maintainer role whose name is OpenCode.',
    ]) {
      expect(normalizeSystemPrompt(text)).toBe(text);
    }
  });
});
