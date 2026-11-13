import { randomUUID } from 'node:crypto';
import type {
  TrafficAuditDetail,
  TrafficAuditBodyDescriptor,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';

export function syntheticHarDetail(): Extract<TrafficAuditDetail, { recordKind: 'request' }> {
  const id = randomUUID();
  return {
    recordKind: 'request',
    request: {
      id,
      sessionId: null,
      timestamp: 1000,
      completedAt: 11000,
      method: 'POST',
      url: '/v1/messages?api_key=secret',
      protocol: 'anthropic',
      trafficClass: 'model',
      operation: null,
      model: 'requested',
      mappedModel: 'mapped',
      physicalModel: 'physical',
      physicalModelFamily: null,
      attributedAccountId: null,
      hasTextOutput: true,
      hasImageOutput: false,
      clientIp: null,
      username: null,
      requestHeaders: '{"authorization":"Bearer secret"}',
      requestQuery: null,
      status: 200,
      durationMs: 10000,
      outcome: 'completed',
      error: null,
      responseHeaders: null,
      responsePartial: false,
      inputTokens: 10,
      outputTokens: 1,
      cachedTokens: null,
      reasoningTokens: null,
    },
    attempts: [
      {
        id: randomUUID(),
        parentId: id,
        accountId: null,
        accountIdHash: null,
        attemptIndex: 1,
        timestamp: 1100,
        completedAt: 9100,
        durationMs: 8000,
        endpoint: 'https://user:secret@upstream.example.test/generate?access_token=secret',
        operation: 'generateContent',
        model: 'physical',
        outcome: 'upstream_error',
        status: 503,
        requestHeaders: '{"x-api-key":"secret"}',
        responseHeaders: null,
        responsePartial: false,
        error: 'unavailable',
      },
    ],
    bodies: [],
  };
}

export function syntheticHarBody(
  ownerId: string,
  ownerKind: 'parent' | 'attempt',
  data: string,
): TrafficAuditBodyDescriptor {
  return {
    id: randomUUID(),
    ownerId,
    ownerKind,
    direction: 'request',
    kind: 'json',
    representation: 'sanitized_json',
    state: 'complete',
    logicalBytes: Buffer.byteLength(data),
    storedBytes: Buffer.byteLength(data),
    chunkCount: 1,
    sha256: null,
    sha256Scope: 'unavailable',
    oversized: false,
    partial: false,
    droppedReason: null,
    terminalStatus: 'completed',
    parseErrorOffset: null,
    errorSummary: null,
    completedAt: 11000,
  };
}
