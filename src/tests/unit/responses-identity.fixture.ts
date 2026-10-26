import type { ResponsesInitialIdentity } from '@/modules/proxy-gateway/server/modules/openai/responses/responses-initial-identity';

/** Synthetic metadata for storage/authorization tests that do not exercise task derivation. */
export const responsesIdentityFixture = Object.freeze({
  version: 1,
  origin: 'content',
  initialTaskFingerprint: '0'.repeat(64),
} satisfies ResponsesInitialIdentity);
