import { describe, expect, it } from 'vitest';
import {
  ContextCompactionCoordinator,
  DEFAULT_COWORK_AUTO_THRESHOLD,
  fingerprintCompactionInput,
  resolveCompactionPolicy,
  resolveManualCompactionCommand,
} from '@/server/gateway/common/context-compaction';

describe('Cowork context compaction coordination', () => {
  it('computes the target from fixed overhead and raises the effective threshold', () => {
    const defaultPolicy = resolveCompactionPolicy({
      fixedOverheadTokens: 20_000,
      configuredThreshold: DEFAULT_COWORK_AUTO_THRESHOLD,
      estimatedInputTokens: 230_000,
    });
    expect(defaultPolicy).toEqual({
      targetTokens: 35_000,
      effectiveAutoThreshold: 200_000,
      shouldAutoCompact: true,
    });

    expect(
      resolveCompactionPolicy({
        fixedOverheadTokens: 190_000,
        configuredThreshold: 200_000,
        estimatedInputTokens: 210_000,
      }),
    ).toEqual({
      targetTokens: 205_000,
      effectiveAutoThreshold: 230_000,
      shouldAutoCompact: false,
    });
  });

  it('accepts only an explicit first-line manual command', () => {
    expect(resolveManualCompactionCommand('please compact this')).toBeNull();
    expect(resolveManualCompactionCommand('`./compact`')).toBeNull();
    expect(resolveManualCompactionCommand('> ./compact')).toBeNull();
    expect(
      resolveManualCompactionCommand('<system-reminder>x</system-reminder>\n./compact now'),
    ).toBe('./compact now');
    expect(resolveManualCompactionCommand('/compact')).toBe('/compact');
    expect(resolveManualCompactionCommand('/compact.')).toBe('/compact.');
    expect(resolveManualCompactionCommand('/compact. followed by prose')).toBeNull();
  });

  it('deduplicates concurrent work for one tenant, session and generation', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 1000 });
    const request = {
      tenantId: 'tenant-a',
      clientSessionId: 'session-a',
      generation: 1,
      mode: 'auto' as const,
      source: 'cowork' as const,
      estimatedInputTokens: 230_000,
      targetTokens: 35_000,
      inputFingerprint: fingerprintCompactionInput({ messages: ['a'] }),
    };

    expect(coordinator.acquire(request).kind).toBe('acquired');
    expect(coordinator.acquire(request).kind).toBe('reused');
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 1,
      confirmations: 0,
      protections: 0,
    });
  });

  it('requires an adopted and changed history before completion', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 1000 });
    const inputFingerprint = fingerprintCompactionInput({ messages: ['before'] });
    const acquired = coordinator.acquire({
      tenantId: 'tenant-a',
      clientSessionId: 'session-a',
      generation: 2,
      mode: 'manual',
      source: 'cowork',
      estimatedInputTokens: 80_000,
      targetTokens: 35_000,
      inputFingerprint,
    });
    if (acquired.kind !== 'acquired') {
      throw new Error('Expected an acquired compaction operation');
    }

    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint: inputFingerprint,
        newEstimatedInputTokens: 20_000,
        now: 1000,
      }),
    ).toBeNull();

    expect(coordinator.markSummaryInFlight(acquired.operation.id)?.status).toBe(
      'summary-in-flight',
    );
    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint: inputFingerprint,
        newEstimatedInputTokens: 20_000,
        now: 1000,
      }),
    ).toBeNull();

    const newHistoryFingerprint = fingerprintCompactionInput({ messages: ['after'] });
    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint,
        newEstimatedInputTokens: 20_000,
        now: 1000,
      }),
    ).toBeNull();
    expect(
      coordinator.markProviderSummarySucceeded({
        operationId: acquired.operation.id,
        summaryFingerprint: fingerprintCompactionInput({ summary: 'provider' }),
        now: 1000,
      })?.status,
    ).toBe('summary-succeeded');
    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint,
        newEstimatedInputTokens: 20_000,
        now: 1000,
      }),
    ).toEqual({
      operationId: acquired.operation.id,
      historyFingerprint: newHistoryFingerprint,
      beforeTokens: 80_000,
      afterTokens: 20_000,
      savedEstimatedTokens: 60_000,
      createdAt: 1000,
      expiresAt: 61_000,
    });
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 0,
      confirmations: 1,
      protections: 1,
    });
  });

  it('does not let a failed or cancelled summary complete later', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 1000 });
    const acquired = coordinator.acquire({
      tenantId: 'tenant-a',
      clientSessionId: 'session-a',
      generation: 3,
      mode: 'auto',
      source: 'cowork',
      estimatedInputTokens: 80_000,
      targetTokens: 35_000,
      inputFingerprint: 'before',
    });
    if (acquired.kind !== 'acquired') {
      throw new Error('Expected an acquired compaction operation');
    }

    coordinator.markSummaryInFlight(acquired.operation.id);
    expect(coordinator.fail(acquired.operation.id)).toBe(true);
    expect(
      coordinator.markProviderSummarySucceeded({
        operationId: acquired.operation.id,
        summaryFingerprint: 'late-summary',
      }),
    ).toBeNull();
    expect(
      coordinator.complete({
        operationId: acquired.operation.id,
        newHistoryFingerprint: 'after',
        newEstimatedInputTokens: 20_000,
      }),
    ).toBeNull();
  });

  it('binds a confirmation to its exact history and expires active work', () => {
    let now = 1000;
    const coordinator = new ContextCompactionCoordinator({
      now: () => now,
      operationTtlMs: 10,
    });

    expect(
      coordinator.acquire({
        tenantId: 'tenant-a',
        clientSessionId: 'session-a',
        generation: 1,
        mode: 'auto',
        source: 'cowork',
        estimatedInputTokens: 35_000,
        targetTokens: 35_000,
        inputFingerprint: 'same',
      }),
    ).toEqual({ kind: 'rejected', reason: 'below-target' });

    expect(
      coordinator.acquire({
        tenantId: 'tenant-a',
        clientSessionId: 'session-a',
        generation: 1,
        mode: 'auto',
        source: 'cowork',
        estimatedInputTokens: 40_000,
        targetTokens: 35_000,
        inputFingerprint: 'same',
      }).kind,
    ).toBe('acquired');

    now = 1011;
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 0,
      confirmations: 0,
      protections: 0,
    });
  });

  it('keeps tenants isolated when their session IDs are identical', () => {
    const coordinator = new ContextCompactionCoordinator({ now: () => 1000 });
    const base = {
      clientSessionId: 'same-session',
      generation: 1,
      mode: 'auto' as const,
      source: 'cowork' as const,
      estimatedInputTokens: 80_000,
      targetTokens: 35_000,
      inputFingerprint: 'fingerprint',
    };

    expect(coordinator.acquire({ ...base, tenantId: 'tenant-a' }).kind).toBe('acquired');
    expect(coordinator.acquire({ ...base, tenantId: 'tenant-b' }).kind).toBe('acquired');
    expect(coordinator.snapshot()).toEqual({
      activeOperations: 2,
      confirmations: 0,
      protections: 0,
    });
  });
});
