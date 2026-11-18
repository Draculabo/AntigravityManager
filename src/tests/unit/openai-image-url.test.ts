import { describe, expect, it } from 'vitest';

import { resolveOpenAIImageUrl } from '@/server/gateway/modules/openai/openai-image-url';

describe('resolveOpenAIImageUrl', () => {
  it.each([
    ['a legacy string URL', 'data:image/png;base64,AA=='],
    ['the current object form', { url: 'data:image/png;base64,AA==', detail: 'high' }],
  ])('accepts %s', (_label, value) => {
    expect(resolveOpenAIImageUrl(value)).toBe('data:image/png;base64,AA==');
  });

  it.each([
    undefined,
    null,
    '',
    { url: '' },
    { url: 7 },
    { url: 'https://example.test', detail: 7 },
  ])('rejects malformed image URLs', (value) => {
    expect(resolveOpenAIImageUrl(value)).toBeNull();
  });
});
