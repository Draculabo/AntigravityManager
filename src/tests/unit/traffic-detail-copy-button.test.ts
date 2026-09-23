import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ copyCurl: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({
      data: {
        recordKind: 'request',
        request: { id: 'request-1', outcome: 'completed', trafficClass: 'model' },
        attempts: [],
        bodies: [],
      },
      isLoading: false,
    }),
  };
});
vi.mock('@/modules/proxy-gateway/traffic-monitor/AuditBodyViewer', () => ({
  AuditBodyViewer: () => null,
}));

import { TrafficDetailDialog } from '@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog';

describe('traffic detail cURL action', () => {
  afterEach(() => mocks.copyCurl.mockReset());

  it('offers an icon-only copy action with the current-credential warning', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrafficDetailDialog, {
          id: 'request-1',
          onOpenChange: vi.fn(),
          onCopyCurl: mocks.copyCurl,
          includeCredentials: true,
        }),
      ),
    );

    const button = screen.getByRole('button', {
      name: 'traffic.copy-request-curl · traffic.current-credential',
    });
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent).toBe('');
    fireEvent.focus(button);
    expect(
      await screen.findByRole('tooltip', {
        name: 'traffic.copy-request-curl · traffic.current-credential',
      }),
    ).toBeTruthy();
    fireEvent.click(button);
    expect(mocks.copyCurl).toHaveBeenCalledExactlyOnceWith('request-1');
  });
});
