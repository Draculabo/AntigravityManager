import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrafficTable } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficTable';
import type { TrafficAuditSummary } from '@/modules/proxy-gateway/audit/traffic-audit.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 44,
    getVirtualItems: () => [{ index: 0, size: 44, start: 0 }],
    scrollToIndex: vi.fn(),
  }),
}));
afterEach(cleanup);

describe('traffic table fallback indication', () => {
  it.each([0, 1])(
    'uses recorded failures rather than total operations (%s failures)',
    (failedAttemptCount) => {
      const item: TrafficAuditSummary = {
        id: 'request',
        recordKind: 'request',
        trafficClass: 'model',
        attemptCount: 2,
        failedAttemptCount,
        outcome: 'completed',
        status: 200,
        attributedAccountId: null,
        completedAt: 2,
        durationMs: 1,
        hasImageOutput: false,
        hasTextOutput: true,
        inputTokens: 1,
        outputTokens: 1,
        mappedModel: null,
        method: 'POST',
        model: 'test',
        physicalModel: 'test',
        physicalModelFamily: null,
        protocol: 'openai',
        timestamp: 1,
        url: '/v1/chat/completions',
      };
      render(
        createElement(TrafficTable, {
          items: [item],
          loading: false,
          tab: 'model',
          onOpen: vi.fn(),
          onCopyCurl: vi.fn(),
        }),
      );
      expect(Boolean(screen.queryByTitle('traffic.recovered-hint'))).toBe(failedAttemptCount > 0);
    },
  );
});
