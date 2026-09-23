import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { createGeminiRequestEnvelope } from '@/modules/proxy-gateway/server/modules/gemini/gemini-request-envelope';
import type { GeminiRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { setServerConfig } from '@/server/server-config';

const GLOBAL_PROMPT = 'Always answer in Simplified Chinese.';

function enableGlobalSystemPrompt(): void {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    global_system_prompt: {
      enabled: true,
      content: `  ${GLOBAL_PROMPT}  `,
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
      `<global_system_prompt>\n${GLOBAL_PROMPT}\n</global_system_prompt>`,
    );
    expect(instruction).toContain(
      '<customizations>\nPreserve the caller policy.\n</customizations>',
    );
    expect(instruction.indexOf('<identity>')).toBeLessThan(
      instruction.indexOf('<global_system_prompt>'),
    );
    expect(instruction.indexOf('<global_system_prompt>')).toBeLessThan(
      instruction.indexOf('<customizations>'),
    );
  });

  it('does not duplicate a configured prompt already supplied by an OpenAI or Anthropic client', () => {
    enableGlobalSystemPrompt();

    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      system: `${GLOBAL_PROMPT}\nPreserve this caller instruction.`,
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const instruction = body.request.systemInstruction?.parts[0]?.text ?? '';

    expect(countOccurrences(instruction, GLOBAL_PROMPT)).toBe(1);
    expect(instruction).toContain('Preserve this caller instruction.');
  });

  it('injects a separately spaced global part for native Gemini requests and avoids duplicates', () => {
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
      { text: `${GLOBAL_PROMPT}\n\n` },
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
});
