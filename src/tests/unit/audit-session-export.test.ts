import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { auditSessionForExport } from '@/modules/proxy-gateway/audit/audit-session-export';
import type { TrafficAuditDetail } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const sessionId = `session:affinity:v1:${'a'.repeat(64)}`;
const id = randomUUID();
const bodyId = randomUUID();
const detail: Extract<TrafficAuditDetail, { recordKind: 'request' }> = {
  recordKind: 'request',
  request: {
    id,
    sessionId,
    timestamp: 1,
    completedAt: 2,
    method: 'POST',
    url: '/v1/messages',
    protocol: 'anthropic',
    trafficClass: 'model',
    operation: null,
    model: 'requested',
    mappedModel: 'mapped',
    physicalModel: 'physical',
    physicalModelFamily: null,
    attributedAccountId: 'account',
    hasTextOutput: true,
    hasImageOutput: false,
    clientIp: null,
    username: null,
    requestHeaders: '{"authorization":"[REDACTED]"}',
    requestQuery: null,
    status: 200,
    durationMs: 1,
    outcome: 'completed',
    error: null,
    responseHeaders: null,
    responsePartial: true,
    inputTokens: 10,
    outputTokens: 1,
    cachedTokens: null,
    reasoningTokens: null,
  },
  attempts: [],
  bodies: [
    {
      id: bodyId,
      ownerId: id,
      ownerKind: 'parent',
      direction: 'response',
      kind: 'text',
      representation: 'sanitized_text',
      state: 'incomplete',
      logicalBytes: 20,
      storedBytes: 3,
      chunkCount: 1,
      sha256: null,
      sha256Scope: 'unavailable',
      oversized: false,
      partial: true,
      droppedReason: 'audit_disk_budget',
      terminalStatus: 'completed',
      parseErrorOffset: null,
      errorSummary: null,
      completedAt: 2,
    },
  ],
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'agm-session-export-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function source() {
  return {
    snapshot: vi.fn(async () => ({ ids: [id], fingerprint: 'a'.repeat(64) })),
    detail: vi.fn<(_id: string) => Promise<TrafficAuditDetail | null>>(async () => detail),
    body: vi.fn(async function* () {
      yield 'abc';
    }),
  };
}
it('writes a versioned session with exact parent/body identity and partial capture metadata', async () => {
  const read = source();
  const owner = createAuditFileOwner({
    harContent: async function* () {
      throw new Error('HAR is outside this session fixture');
    },
    bodyContent: read.body,
    sessionContent: (key) => auditSessionForExport(key, read),
  });
  const filePath = path.join(directory, 'session.ndjson');
  expect(await owner.exportSession({ sessionId, filePath })).toEqual({ status: 'saved' });
  await owner.drain();
  const lines: unknown[] = (await readFile(filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((value) => JSON.parse(value));
  expect(lines).toEqual([
    { kind: 'session', format: 'agm-audit-session', version: 1, sessionId, requestCount: 1 },
    { kind: 'request', detail },
    { kind: 'body-start', bodyId },
    { kind: 'body-chunk', bodyId, data: 'abc' },
    { kind: 'body-end', bodyId },
    { kind: 'complete', requestCount: 1 },
  ]);
  expect(read.snapshot).toHaveBeenNthCalledWith(2, sessionId);
});
it.each(['changed', 'deleted', 'wrong-session', 'body-missing'] as const)(
  'preserves the destination and removes partial output when %s',
  async (failure) => {
    const read = source();
    if (failure === 'changed') {
      read.snapshot
        .mockResolvedValueOnce({ ids: [id], fingerprint: 'a'.repeat(64) })
        .mockResolvedValue({ ids: [id], fingerprint: 'b'.repeat(64) });
    }
    if (failure === 'deleted') {
      read.detail.mockResolvedValue(null);
    }
    if (failure === 'wrong-session') {
      read.detail.mockResolvedValue({
        ...detail,
        request: { ...detail.request, sessionId: 'other' },
      });
    }
    if (failure === 'body-missing') {
      read.body.mockImplementation(async function* () {
        yield 'partial';
        throw new Error('deleted during export');
      });
    }
    const owner = createAuditFileOwner({
      harContent: async function* () {
        throw new Error('HAR is outside this session fixture');
      },
      bodyContent: read.body,
      sessionContent: (key) => auditSessionForExport(key, read),
    });
    const filePath = path.join(directory, 'existing.ndjson');
    await writeFile(filePath, 'keep destination');
    await expect(owner.exportSession({ sessionId, filePath })).rejects.toThrow(
      'Audit export is unavailable.',
    );
    await owner.drain();
    expect(await readFile(filePath, 'utf8')).toBe('keep destination');
    expect(await readdir(directory)).toEqual(['existing.ndjson']);
  },
);
