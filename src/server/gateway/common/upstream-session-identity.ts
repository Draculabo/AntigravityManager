import { createHash, randomUUID } from 'node:crypto';
import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';

export interface UpstreamSessionIdentity {
  readonly sessionId: string;
  readonly conversationId: string;
}

/** Local lifecycle generations do not reset provider state; recovery generation is separate. */
export function createUpstreamSessionIdentity(
  accountId: string,
  storeKey: string,
): UpstreamSessionIdentity {
  const seed = JSON.stringify(['upstream-session:v1', accountId, storeKey, 0]);
  const fingerprint = createHash('sha256').update(seed).digest();
  return {
    // The provider uses a signed 64-bit decimal string; never round through Number.
    sessionId: fingerprint.readBigInt64BE().toString(),
    conversationId: createHash('sha256').update(storeKey).digest('hex').slice(0, 16),
  };
}

/** Shallow ownership at the wire boundary keeps full content shared and request IDs unique per send. */
export function withUpstreamSessionIdentity(
  body: GeminiInternalRequest,
  identity: UpstreamSessionIdentity,
): GeminiInternalRequest {
  return {
    ...body,
    requestId: `agent/${identity.conversationId}/${Date.now()}/${randomUUID().replaceAll('-', '')}/0`,
    request: { ...body.request, sessionId: identity.sessionId },
  };
}
