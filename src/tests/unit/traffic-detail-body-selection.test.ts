import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { index?: number }) =>
      options?.index ? `${key} ${options.index}` : key,
  }),
}));
vi.mock('@tanstack/react-query', async (original) => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({
      data: {
        recordKind: 'request',
        request: { id: 'parent', outcome: 'completed', trafficClass: 'model' },
        attempts: [
          {
            id: 'first',
            attemptIndex: 1,
            outcome: 'completed',
            endpoint: 'https://example.test/one',
          },
          {
            id: 'second',
            attemptIndex: 2,
            outcome: 'completed',
            endpoint: 'https://example.test/two',
          },
        ],
        bodies: [
          { id: 'first-body', ownerId: 'first', ownerKind: 'attempt', direction: 'response' },
          { id: 'parent-body', ownerId: 'parent', ownerKind: 'parent', direction: 'response' },
        ],
      },
      isLoading: false,
    }),
  };
});
vi.mock('@/modules/proxy-gateway/traffic-monitor/AuditBodyViewer', () => ({
  AuditBodyViewer: ({ body }: { body: { id: string } | null }) =>
    createElement('div', { 'data-testid': 'selected-capture' }, body?.id ?? 'missing'),
}));
import { TrafficDetailDialog } from '@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog';

afterEach(cleanup);
describe('traffic attempt capture selection', () => {
  it('clears the previous capture when explicitly selecting an attempt without a body', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrafficDetailDialog, {
          id: 'parent',
          onOpenChange: vi.fn(),
          onCopyCurl: vi.fn(),
          includeCredentials: false,
        }),
      ),
    );
    fireEvent.click(screen.getAllByRole('button', { name: /traffic.attempt 1/ })[0]);
    expect(await screen.findByTestId('selected-capture')).toHaveProperty(
      'textContent',
      'first-body',
    );
    expect(screen.getByRole('button', { name: 'traffic.attempt 1 traffic.response' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /traffic.attempt 2/ })[0]);
    expect(screen.getByTestId('selected-capture')).toHaveProperty('textContent', 'missing');
  });
});
