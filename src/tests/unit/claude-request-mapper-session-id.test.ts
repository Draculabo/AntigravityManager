import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createRequest(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return {
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: 'Help me fix the issue.' }],
    ...overrides,
  };
}

/**
 * The provider rejects the whole request with
 * `Invalid JSON payload received. Unknown name "sessionId": Cannot find field.`
 * when the v1internal envelope carries one, so no client-supplied identifier
 * may reach it. Reported in #227, where the Claude CLI sends `metadata.user_id`
 * and every request fails.
 */
describe('ClaudeRequestMapper session identity', () => {
  it('never puts a sessionId on the outgoing payload for metadata.user_id', () => {
    const body = transformClaudeRequestIn(
      createRequest({ metadata: { user_id: 'user_e5f1a0c2' } }),
      'project-1',
    );

    expect(body).not.toHaveProperty('sessionId');
    expect(JSON.stringify(body)).not.toContain('sessionId');
  });

  it('leaves the rest of the envelope untouched when metadata is present', () => {
    const withMetadata = transformClaudeRequestIn(
      createRequest({ metadata: { user_id: 'user_e5f1a0c2' } }),
      'project-1',
    );
    const withoutMetadata = transformClaudeRequestIn(createRequest(), 'project-1');

    expect(Object.keys(withMetadata)).toEqual(Object.keys(withoutMetadata));
    expect(withMetadata.request).toEqual(withoutMetadata.request);
    expect(withMetadata.model).toBe(withoutMetadata.model);
  });
});
