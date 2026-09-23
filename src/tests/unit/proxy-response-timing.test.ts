import { describe, expect, it } from 'vitest';

import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  buildProxyResponseTimingHeaders,
  markProxyCleanComplete,
  markProxyNormalizationComplete,
  markProxyNormalizationStarted,
  markProxyUpstreamFirstByte,
  markProxyUpstreamStarted,
  recordProxyThinkingFill,
} from '@/modules/proxy-gateway/server/common/proxy-response-timing';

describe('proxy response timing headers', () => {
  it('returns no success timing headers outside a model request context', () => {
    expect(buildProxyResponseTimingHeaders()).toEqual({});
  });

  it('reports the four measured stages and a client-visible session id', () => {
    const context = {
      attemptSequence: 0,
      clientSessionId: 'client-session-1',
      parent: null,
      proxyTiming: {
        cleanMs: null,
        normMs: null,
        normalizationStartedAt: null,
        startedAt: performance.now(),
        thinkingMs: 0,
        ttftMs: null,
        upstreamStartedAt: null,
      },
      thoughtSessionKey: 'tenant-hash:client-session-1',
      thoughtSessionStable: true,
    };
    const headers = runWithTrafficAuditRequestContext(context, () => {
      markProxyCleanComplete();
      markProxyNormalizationStarted();
      markProxyNormalizationComplete();
      recordProxyThinkingFill(performance.now() - 2);
      markProxyUpstreamStarted();
      markProxyUpstreamFirstByte();
      return buildProxyResponseTimingHeaders();
    });

    expect(headers['X-Session-Id']).toBe('client-session-1');
    expect(headers['X-Antigravity-Session-Id']).toBe('client-session-1');
    for (const name of [
      'X-Timing-Clean-Ms',
      'X-Timing-Norm-Ms',
      'X-Timing-Thinking-Ms',
      'X-Timing-Ttft-Ms',
    ]) {
      expect(headers[name]).toMatch(/^\d+\.\d{3}$/u);
    }
    expect(Number(headers['X-Timing-Thinking-Ms'])).toBeGreaterThan(0);
  });
});
