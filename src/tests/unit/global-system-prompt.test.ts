import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { createGeminiRequestEnvelope } from '@/server/gateway/modules/gemini/gemini-request-envelope';
import type { GeminiRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { setServerConfig } from '@/server/server-config';

const GLOBAL_PROMPT = 'Always answer in Simplified Chinese.';
const CONFIGURED_PROMPT = `  ${GLOBAL_PROMPT}  `;

function enableGlobalSystemPrompt(): void {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    global_system_prompt: {
      enabled: true,
      content: CONFIGURED_PROMPT,
    },
  });
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('global system prompt compatibility', () => {
  beforeEach(() => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('places the configured prompt once after the mapped identity', () => {
    enableGlobalSystemPrompt();

    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      system: 'Preserve the caller policy.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const instruction = body.request.systemInstruction?.parts[0]?.text ?? '';

    expect(instruction).toContain(
      `<global_system_prompt>\n${CONFIGURED_PROMPT}\n</global_system_prompt>\nPreserve the caller policy.`,
    );
  });

  it('preserves a caller-supplied repeat independently of the configured prompt', () => {
    enableGlobalSystemPrompt();

    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      system: `${GLOBAL_PROMPT}\nPreserve this caller instruction.`,
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const instruction = body.request.systemInstruction?.parts[0]?.text ?? '';

    expect(countOccurrences(instruction, GLOBAL_PROMPT)).toBe(2);
    expect(instruction.startsWith('<global_system_prompt>')).toBe(true);
    expect(instruction).toContain('Preserve this caller instruction.');
  });

  it('injects one owned global part and retains native caller repetitions', () => {
    enableGlobalSystemPrompt();
    const request: GeminiRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }],
      systemInstruction: {
        parts: [{ text: 'Preserve this native caller instruction.' }],
      },
    };

    const injected = createGeminiRequestEnvelope(
      'gemini-3-flash',
      request,
      'project-a',
      'generate-content',
      'test-agent',
      'request-id',
    );

    expect(injected.request.systemInstruction?.parts).toEqual([
      { text: `<global_system_prompt>\n${CONFIGURED_PROMPT}\n</global_system_prompt>` },
      { text: 'Preserve this native caller instruction.' },
    ]);

    const existing = createGeminiRequestEnvelope(
      'gemini-3-flash',
      {
        ...request,
        systemInstruction: {
          parts: [{ text: `${GLOBAL_PROMPT}\nPreserve this native caller instruction.` }],
        },
      },
      'project-a',
      'generate-content',
      'test-agent',
      'request-id',
    );

    expect(existing.request.systemInstruction?.parts).toEqual([
      { text: `<global_system_prompt>\n${CONFIGURED_PROMPT}\n</global_system_prompt>` },
      { text: `${GLOBAL_PROMPT}\nPreserve this native caller instruction.` },
    ]);

    const imageRequest = createGeminiRequestEnvelope(
      'gemini-3-pro-image',
      { contents: [{ role: 'user', parts: [{ text: 'Draw a blue square.' }] }] },
      'project-a',
      'generate-content',
      'test-agent',
      'request-id',
    );

    expect(imageRequest.request.systemInstruction).toBeUndefined();
  });

  it('does not treat a quoted client substring as gateway-owned provenance', () => {
    enableGlobalSystemPrompt();
    const quoted = `Example only:\n\`\`\`text\n${GLOBAL_PROMPT}\n\`\`\``;
    const request = {
      model: 'gemini-3-flash',
      system: quoted,
      messages: [{ role: 'user', content: 'controlled' }],
    };
    const before = structuredClone(request);
    const first = transformClaudeRequestIn(request);
    const second = transformClaudeRequestIn(request);
    expect(first.request.systemInstruction).toEqual({
      parts: [
        {
          text: `<global_system_prompt>\n${CONFIGURED_PROMPT}\n</global_system_prompt>\n${quoted}`,
        },
      ],
    });
    expect(second.request.systemInstruction).toEqual(first.request.systemInstruction);
    expect(request).toStrictEqual(before);
  });
});
