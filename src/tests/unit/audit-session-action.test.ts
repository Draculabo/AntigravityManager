import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuditSessionExportAction } from '@/modules/proxy-gateway/traffic-monitor/AuditSessionExportAction';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('does not offer an unscoped export or report chooser cancellation as saved', async () => {
  const save = vi.fn(async () => ({ status: 'cancelled' }));
  vi.stubGlobal('electron', { saveTrafficAuditSession: save });
  const view = render(createElement(AuditSessionExportAction, { sessionId: 'legacy' }));
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  view.rerender(
    createElement(AuditSessionExportAction, { sessionId: `session:affinity:v1:${'a'.repeat(64)}` }),
  );
  await act(async () => fireEvent.click(screen.getByRole('button')));
  expect(save).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
});
it('guards duplicate exports and reports only the final owner result', async () => {
  let finish!: (value: { status: 'saved' }) => void;
  const save = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('electron', { saveTrafficAuditSession: save });
  render(
    createElement(AuditSessionExportAction, { sessionId: `session:store:v2:${'b'.repeat(64)}` }),
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('button'));
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  await act(async () => finish({ status: 'saved' }));
  expect(screen.getByRole('status').textContent).toBe('traffic.session-export-saved');
});
it('reports unconfirmed completion without exposing a private owner error', async () => {
  vi.stubGlobal('electron', {
    saveTrafficAuditSession: vi.fn(async () => {
      throw new Error('private profile path');
    }),
  });
  render(
    createElement(AuditSessionExportAction, { sessionId: `session:affinity:v1:${'a'.repeat(64)}` }),
  );
  await act(async () => fireEvent.click(screen.getByRole('button')));
  expect(screen.getByRole('alert').textContent).toBe('traffic.session-export-failed');
});
