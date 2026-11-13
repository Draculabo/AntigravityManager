import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TrafficAuditAttemptDetailSchema } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { AttemptTimingDetails } from '@/modules/proxy-gateway/traffic-monitor/AttemptTimingDetails';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function attempt(durationMs: number | null, measured = false) {
  return TrafficAuditAttemptDetailSchema.parse({
    accountId: null,
    accountIdHash: null,
    attemptIndex: 1,
    completedAt: 10000,
    durationMs,
    endpoint: 'https://example.test/generate',
    error: null,
    id: 'attempt-1',
    model: 'model',
    operation: 'generateContent',
    outcome: 'completed',
    parentId: 'parent-1',
    requestHeaders: '{}',
    responseHeaders: null,
    responsePartial: false,
    status: 200,
    timestamp: 1000,
    ...(measured
      ? {
          timing: {
            version: 1,
            uploadFinishedMs: 0,
            responseHeadersMs: 150,
            firstByteMs: 180,
            firstUsableOutputMs: 2000,
          },
        }
      : {}),
  });
}

it('distinguishes measured byte/output stages, zero upload time and earlier attempt duration', () => {
  render(
    createElement(AttemptTimingDetails, {
      attempt: attempt(2500, true),
      precedingAttempts: [attempt(8000)],
    }),
  );
  expect(screen.getByText('0 ms')).toBeTruthy();
  expect(screen.getByText('150 ms')).toBeTruthy();
  expect(screen.getByText('180 ms')).toBeTruthy();
  expect(screen.getByText('2000 ms')).toBeTruthy();
  expect(screen.getByText('8000 ms')).toBeTruthy();
  expect(screen.getByText('traffic.attempt-timing.first-byte')).toBeTruthy();
  expect(screen.getByText('traffic.attempt-timing.first-output')).toBeTruthy();
});

it('keeps historical stages and an incomplete earlier-attempt total unknown', () => {
  render(
    createElement(AttemptTimingDetails, {
      attempt: attempt(2500),
      precedingAttempts: [attempt(8000), attempt(null)],
    }),
  );
  expect(screen.getAllByText('traffic.unknown')).toHaveLength(5);
  expect(screen.queryByText('8000 ms')).toBeNull();
  expect(screen.queryByText('0 ms')).toBeNull();
});
