import { describe, expect, it } from 'vitest';
import { ContextCompactionCoordinator } from '@/server/gateway/common/context-compaction';

const request = {
  tenantId: 'tenant-a',
  clientSessionId: 'session-a',
  generation: 1,
  mode: 'manual' as const,
  source: 'cowork' as const,
  estimatedInputTokens: 80_000,
  targetTokens: 35_000,
  inputFingerprint: 'before',
};
function completed(
  coordinator: ContextCompactionCoordinator,
  overrides: Partial<typeof request> = {},
) {
  const acquired = coordinator.acquire({ ...request, ...overrides });
  if (acquired.kind !== 'acquired') {
    throw new Error('Expected acquired operation');
  }
  const id = acquired.operation.id;
  coordinator.markSummaryInFlight(id);
  coordinator.markProviderSummarySucceeded({
    operationId: id,
    summaryFingerprint: 'provider-summary',
  });
  expect(
    coordinator.complete({
      operationId: id,
      newHistoryFingerprint: 'adopted',
      newEstimatedInputTokens: 20_000,
    }),
  ).not.toBeNull();
  return {
    tenantId: overrides.tenantId ?? request.tenantId,
    clientSessionId: request.clientSessionId,
    generation: overrides.generation ?? request.generation,
    operationId: id,
    adoptedHistoryFingerprint: 'adopted',
  };
}

describe('compaction-scoped continuation protection', () => {
  it('keeps separator-bearing tenant/session pairs isolated', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 0 });
    const first = coordinator.acquire({ ...request, tenantId: 'a\u0000b', clientSessionId: 'c' });
    const second = coordinator.acquire({ ...request, tenantId: 'a', clientSessionId: 'b\u0000c' });
    expect(first.kind).toBe('acquired');
    expect(second.kind).toBe('acquired');
    coordinator.invalidate('a', 'b\u0000c');
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 1,
      confirmations: 0,
      protections: 0,
    });
  });
  it('activates only the adopted operation and renews a 30-second sliding window', () => {
    let now = 0;
    const coordinator = new ContextCompactionCoordinator({ now: () => now });
    const proof = completed(coordinator);
    now = 299_999;
    expect(coordinator.continue({ ...proof, tenantId: 'tenant-b' })).toBeNull();
    expect(coordinator.continue({ ...proof, generation: 2 })).toBeNull();
    expect(coordinator.continue({ ...proof, adoptedHistoryFingerprint: 'unrelated' })).toBeNull();
    expect(coordinator.continue(proof)).toEqual({
      ...proof,
      activated: true,
      expiresAt: now + 30_000,
    });
    now += 29_999;
    expect(coordinator.continue(proof)?.expiresAt).toBe(now + 30_000);
    now += 30_000;
    expect(coordinator.continue(proof)).toBeNull();
    expect(coordinator.continue(proof)).toBeNull();
  });

  it('expires an unused protection at 300 seconds without issuing one for failed work', () => {
    let now = 0;
    const coordinator = new ContextCompactionCoordinator({ now: () => now });
    const proof = completed(coordinator);
    now = 300_000;
    expect(coordinator.continue(proof)).toBeNull();
    const acquired = coordinator.acquire({ ...request, generation: 2 });
    if (acquired.kind !== 'acquired') {
      throw new Error('Expected acquired operation');
    }
    coordinator.markSummaryInFlight(acquired.operation.id);
    coordinator.fail(acquired.operation.id);
    expect(
      coordinator.continue({ ...proof, generation: 2, operationId: acquired.operation.id }),
    ).toBeNull();
  });

  it('revokes old confirmation/protection on a new operation and ignores late summaries', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 0 });
    const proof = completed(coordinator);
    const acquired = coordinator.acquire({ ...request, generation: 2 });
    expect(acquired.kind).toBe('acquired');
    expect(coordinator.continue(proof)).toBeNull();
    expect(
      coordinator.getConfirmation(
        request.tenantId,
        request.clientSessionId,
        proof.operationId,
        'adopted',
      ),
    ).toBeNull();
    coordinator.invalidate(request.tenantId, request.clientSessionId);
    if (acquired.kind !== 'acquired') {
      throw new Error('Expected acquired operation');
    }
    expect(
      coordinator.markProviderSummarySucceeded({
        operationId: acquired.operation.id,
        summaryFingerprint: 'late',
      }),
    ).toBeNull();
    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint: 'late',
        newEstimatedInputTokens: 1,
      }),
    ).toBeNull();
  });

  it('refuses new work at protection capacity and preserves another tenant on scoped reset', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 0, maxProtections: 1 });
    const proof = completed(coordinator);
    expect(coordinator.acquire({ ...request, tenantId: 'tenant-b' })).toEqual({
      kind: 'rejected',
      reason: 'capacity',
    });
    coordinator.invalidate('tenant-b', request.clientSessionId);
    expect(coordinator.continue(proof)).not.toBeNull();
    coordinator.invalidate(request.tenantId, request.clientSessionId);
    expect(coordinator.continue(proof)).toBeNull();
    expect(coordinator.acquire({ ...request, tenantId: 'tenant-b' }).kind).toBe('acquired');
  });

  it('never acquires a compaction operation for an unknown client source', () => {
    const coordinator = new ContextCompactionCoordinator();
    expect(coordinator.acquire({ ...request, source: 'unknown' })).toEqual({
      kind: 'rejected',
      reason: 'untrusted-source',
    });
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 0,
      confirmations: 0,
      protections: 0,
    });
  });
});
