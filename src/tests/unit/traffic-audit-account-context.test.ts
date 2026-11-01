import { afterEach, expect, it, vi } from 'vitest';

import {
  runWithTrafficAuditRequestContext,
  setCurrentAuditAccountId,
  startCurrentUpstreamAttempt,
  completeCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

afterEach(() => vi.restoreAllMocks());

it('captures the selected request-local account on each physical attempt', () => {
  const start = vi.spyOn(trafficAuditService, 'startAttempt').mockReturnValue(null);
  const context = {
    attemptSequence: 0,
    parent: { id: 'parent', startedAt: 1, trafficClass: 'model' as const },
    thoughtSessionKey: 'session',
    thoughtSessionStable: true,
  };
  runWithTrafficAuditRequestContext(context, () => {
    setCurrentAuditAccountId('account-a');
    startCurrentUpstreamAttempt({ endpoint: 'https://example.test', operation: 'generate' });
    setCurrentAuditAccountId('account-b');
    startCurrentUpstreamAttempt({ endpoint: 'https://example.test', operation: 'generate' });
  });

  expect(
    start.mock.calls.map(([, index, input]) => ({ index, accountId: input.accountId })),
  ).toEqual([
    { index: 1, accountId: 'account-a' },
    { index: 2, accountId: 'account-b' },
  ]);
});

it('tracks failures without requiring persistence admission and isolates request counters', () => {
  vi.spyOn(trafficAuditService, 'startAttempt').mockReturnValue(null);
  vi.spyOn(trafficAuditService, 'completeAttempt').mockImplementation(() => undefined);
  const first = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'first',
    thoughtSessionStable: true,
  };
  const second = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'second',
    thoughtSessionStable: true,
  };
  runWithTrafficAuditRequestContext(first, () => {
    const handle = startCurrentUpstreamAttempt({
      endpoint: 'https://example.test',
      operation: 'cache',
    });
    completeCurrentUpstreamAttempt(handle, { outcome: 'completed', status: 200 });
    const failed = startCurrentUpstreamAttempt({
      endpoint: 'https://example.test',
      operation: 'generate',
    });
    completeCurrentUpstreamAttempt(failed, { outcome: 'upstream_error', status: 503 });
    runWithTrafficAuditRequestContext(second, () => {
      const successful = startCurrentUpstreamAttempt({
        endpoint: 'https://example.test',
        operation: 'generate',
      });
      completeCurrentUpstreamAttempt(successful, { outcome: 'completed', status: 200 });
    });
  });
  expect(first).toMatchObject({ attemptSequence: 2, failedAttemptCount: 1 });
  expect(second).not.toHaveProperty('failedAttemptCount');
});
