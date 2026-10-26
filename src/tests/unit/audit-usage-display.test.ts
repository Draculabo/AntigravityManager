import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  auditCacheRatio,
  auditStageTimings,
} from '@/modules/proxy-gateway/traffic-monitor/audit-usage-presentation';
import { AuditUsageSummary } from '@/modules/proxy-gateway/traffic-monitor/AuditUsageSummary';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('distinguishes missing, zero and inconsistent cache ratios without redefining input', () => {
  expect(auditCacheRatio(100, 25)).toEqual({ state: 'available', ratio: 0.25 });
  expect(auditCacheRatio(null, 25)).toEqual({ state: 'missing' });
  expect(auditCacheRatio(0, 0)).toEqual({ state: 'zero-input' });
  expect(auditCacheRatio(10, 25)).toEqual({ state: 'inconsistent' });
  expect(auditCacheRatio(-1, 0)).toEqual({ state: 'inconsistent' });
});
it('reads measured stages independently and keeps legacy zero ambiguous', () => {
  expect(
    auditStageTimings(
      JSON.stringify({
        'X-Timing-Clean-Ms': '1.5',
        'X-Timing-Norm-Ms': '0.000',
        'X-Timing-Thinking-Ms': '-2',
        'X-Timing-Ttft-Ms': 'Infinity',
      }),
    ),
  ).toEqual({ clean: 1.5, normalization: null, thinking: null, ttft: null });
  expect(
    auditStageTimings(
      JSON.stringify({
        'x-timing-version': '2',
        'x-timing-norm-ms': '0.000',
        'x-timing-ttft-ms': '8',
      }),
    ),
  ).toEqual({ clean: null, normalization: 0, thinking: null, ttft: 8 });
  for (const headers of ['{bad', '[]', 'x'.repeat(65537), null]) {
    expect(auditStageTimings(headers)).toEqual({
      clean: null,
      normalization: null,
      thinking: null,
      ttft: null,
    });
  }
});
it('shows retained counters, explicit provenance limits and a separate unavailable estimate', () => {
  render(
    createElement(AuditUsageSummary, {
      request: {
        inputTokens: 100,
        outputTokens: 30,
        cachedTokens: 25,
        reasoningTokens: 5,
        responseHeaders: null,
      },
    }),
  );
  expect(screen.getByText('25.0%')).toBeTruthy();
  expect(screen.getByText('traffic.usage-source-unretained')).toBeTruthy();
  expect(screen.getByText('traffic.estimate-not-retained')).toBeTruthy();
  expect(screen.getByText('traffic.stage-overlap-note')).toBeTruthy();
  expect(screen.getAllByText('traffic.unknown')).toHaveLength(4);
});
