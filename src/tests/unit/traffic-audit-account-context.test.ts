import { afterEach, expect, it, vi } from 'vitest';

import {
  runWithTrafficAuditRequestContext,
  setCurrentAuditAccountId,
  startCurrentUpstreamAttempt,
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
