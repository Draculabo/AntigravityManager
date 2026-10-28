import { describe, expect, it } from 'vitest';
import {
  buildPlaygroundCurl,
  buildPlaygroundRequest,
} from '@/modules/proxy-gateway/playground/playground-request';
import { readTargetAccountHeader } from '@/modules/proxy-gateway/server/modules/openai/chat/target-account-header';

describe('Playground reproduction', () => {
  it('preserves all request parameters and shell-quotes apostrophes', () => {
    const input = {
      accountId: 'account-a',
      model: 'requested-alias',
      prompt: `What's "new"?\nnext line`,
      systemPrompt: ' Be concise. ',
      temperature: 0.2,
      maxTokens: 42,
      reasoningEffort: 'high' as const,
    };
    expect(buildPlaygroundRequest(input)).toEqual({
      model: 'requested-alias',
      stream: false,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: input.prompt },
      ],
      temperature: 0.2,
      max_tokens: 42,
      reasoning_effort: 'high',
      thinking: { type: 'enabled', effort: 'high' },
    });
    const curl = buildPlaygroundCurl(input, 'http://localhost:8045', 'served-account');
    expect(curl).toContain(`What'"'"'s`);
    expect(curl).toContain('x-antigravity-account-id: served-account');
    expect(curl).toContain('Bearer YOUR_API_KEY');
    expect(curl).toContain('"max_tokens":42');
  });
});

describe('target account headers', () => {
  it('reads repeated values, preserves precedence, and falls back from an empty header', () => {
    expect(
      readTargetAccountHeader({
        'x-antigravity-account-id': [' beta ', 'alpha'],
        'x-account-id': 'other',
      }),
    ).toBe('beta');
    expect(
      readTargetAccountHeader({ 'x-antigravity-account-id': ' ', 'x-account-id': ['alpha'] }),
    ).toBe('alpha');
    expect(readTargetAccountHeader()).toBeUndefined();
  });
});
