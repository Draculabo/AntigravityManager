import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditHarExportAction } from '@/modules/proxy-gateway/traffic-monitor/AuditHarExportAction';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HAR export action', () => {
  for (const status of ['saved', 'cancelled'] as const) {
    it(`shows the ${status} result and allows another export`, async () => {
      const save = vi.fn(async () => ({ status }));
      vi.stubGlobal('electron', { saveTrafficAuditHar: save });
      render(createElement(AuditHarExportAction, { requestId: 'request-1', disabled: false }));
      fireEvent.click(screen.getByRole('button', { name: 'traffic.export-har' }));
      await waitFor(() =>
        expect(save).toHaveBeenCalledExactlyOnceWith('request-1', 'traffic-request-1.har'),
      );
      await screen.findByRole('button', { name: 'traffic.export-har' });
      expect(screen.queryByRole('status')?.textContent ?? null).toBe(
        status === 'saved' ? 'traffic.har-export-saved' : null,
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });
  }

  it('prevents concurrent exports and reports a retryable failure', async () => {
    let fail: ((reason: Error) => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<{ status: 'saved' }>((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.stubGlobal('electron', { saveTrafficAuditHar: save });
    render(createElement(AuditHarExportAction, { requestId: 'request-1', disabled: false }));
    fireEvent.click(screen.getByRole('button', { name: 'traffic.export-har' }));
    const busy = screen.getByRole('button', { name: 'traffic.har-exporting' });
    expect(busy).toHaveProperty('disabled', true);
    fireEvent.click(busy);
    expect(save).toHaveBeenCalledTimes(1);
    fail?.(new Error('export unavailable'));
    expect((await screen.findByRole('alert')).textContent).toBe('traffic.har-export-failed');
    expect(screen.getByRole('button', { name: 'traffic.export-har' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('does not export an unfinished request', () => {
    const save = vi.fn();
    vi.stubGlobal('electron', { saveTrafficAuditHar: save });
    render(createElement(AuditHarExportAction, { requestId: 'request-1', disabled: true }));
    const button = screen.getByRole('button', { name: 'traffic.export-har' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('traffic.har-export-wait')).toBeTruthy();
  });
});
