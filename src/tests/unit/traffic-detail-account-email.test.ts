import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCloudAccounts = vi.hoisted(() => ({
  accounts: [
    {
      id: '24a461ea-8fd0-4d68-831e-eff58f55f571',
      email: 'user@antigravity.test',
      provider: 'google' as const,
      created_at: 1000,
      last_used: 2000,
      proxy_configured: false,
    },
  ],
}));

let currentRequestDetail: {
  recordKind: 'request';
  request: {
    id: string;
    outcome: string;
    trafficClass: string;
    attributedAccountId?: string | null;
  };
  attempts: never[];
  bodies: never[];
} = {
  recordKind: 'request',
  request: {
    id: 'req-1',
    outcome: 'completed',
    trafficClass: 'model',
    attributedAccountId: '24a461ea-8fd0-4d68-831e-eff58f55f571',
  },
  attempts: [],
  bodies: [],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: { queryKey?: unknown[] }) => {
      const key = options?.queryKey;
      if (Array.isArray(key) && key[0] === 'gateway' && key[1] === 'traffic-detail') {
        return {
          data: currentRequestDetail,
          isLoading: false,
          isError: false,
        };
      }
      return {
        data: undefined,
        isLoading: false,
        isError: false,
      };
    },
  };
});

vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => ({
    data: mockCloudAccounts.accounts,
    isLoading: false,
  }),
}));

vi.mock('@/modules/proxy-gateway/traffic-monitor/AuditBodyViewer', () => ({
  AuditBodyViewer: () => null,
}));

import { TrafficDetailDialog } from '@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog';

describe('TrafficDetailDialog account email', () => {
  beforeEach(() => {
    currentRequestDetail = {
      recordKind: 'request',
      request: {
        id: 'req-1',
        outcome: 'completed',
        trafficClass: 'model',
        attributedAccountId: '24a461ea-8fd0-4d68-831e-eff58f55f571',
      },
      attempts: [],
      bodies: [],
    };
  });

  it('renders the account email field immediately after the account field with the matching email', () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrafficDetailDialog, {
          id: 'req-1',
          onOpenChange: vi.fn(),
          onCopyCurl: vi.fn(),
          includeCredentials: false,
        }),
      ),
    );

    const labels = document.body.querySelectorAll('dt');
    const labelTexts = Array.from(labels).map((element) => element.textContent?.trim());

    const accountIndex = labelTexts.indexOf('traffic.account');
    const emailIndex = labelTexts.indexOf('traffic.account-email');

    expect(accountIndex).toBeGreaterThanOrEqual(0);
    expect(emailIndex).toBe(accountIndex + 1);

    expect(screen.getAllByText('user@antigravity.test').length).toBeGreaterThan(0);
  });

  it('renders a dash for account email when attributed account is unknown or not found', () => {
    currentRequestDetail = {
      recordKind: 'request',
      request: {
        id: 'req-2',
        outcome: 'completed',
        trafficClass: 'model',
        attributedAccountId: 'unknown-account-id',
      },
      attempts: [],
      bodies: [],
    };

    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrafficDetailDialog, {
          id: 'req-2',
          onOpenChange: vi.fn(),
          onCopyCurl: vi.fn(),
          includeCredentials: false,
        }),
      ),
    );

    const labels = document.body.querySelectorAll('dt');
    const labelTexts = Array.from(labels).map((element) => element.textContent?.trim());
    const emailIndex = labelTexts.indexOf('traffic.account-email');

    expect(emailIndex).toBeGreaterThanOrEqual(0);

    const dds = document.body.querySelectorAll('dd');
    expect(dds[emailIndex]?.textContent?.trim()).toBe('—');
  });

  it('renders a dash for account email when attributed account is null', () => {
    currentRequestDetail = {
      recordKind: 'request',
      request: {
        id: 'req-3',
        outcome: 'completed',
        trafficClass: 'model',
        attributedAccountId: null,
      },
      attempts: [],
      bodies: [],
    };

    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrafficDetailDialog, {
          id: 'req-3',
          onOpenChange: vi.fn(),
          onCopyCurl: vi.fn(),
          includeCredentials: false,
        }),
      ),
    );

    const labels = document.body.querySelectorAll('dt');
    const labelTexts = Array.from(labels).map((element) => element.textContent?.trim());
    const emailIndex = labelTexts.indexOf('traffic.account-email');

    expect(emailIndex).toBeGreaterThanOrEqual(0);

    const dds = document.body.querySelectorAll('dd');
    expect(dds[emailIndex]?.textContent?.trim()).toBe('—');
  });
});
