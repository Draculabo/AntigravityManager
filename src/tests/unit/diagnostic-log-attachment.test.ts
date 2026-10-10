import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiagnosticLogAttachment } from '@/modules/app-shell/components/DiagnosticLogAttachment';

const api = vi.hoisted(() => ({ prepare: vi.fn(), save: vi.fn(), discard: vi.fn() }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { app: { diagnosticLogs: api } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const preview = {
  id: '11111111-1111-4111-8111-111111111111',
  text: '[Content removed] {"status":502}',
  bytes: 32,
  missing: ['core'],
  truncated: true,
  removed: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.prepare.mockResolvedValue({ status: 'ready', preview });
  api.save.mockResolvedValue({ status: 'saved' });
  api.discard.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('requires generation and preview before save, shows incompleteness and supports cancelled-save retry', async () => {
  render(createElement(DiagnosticLogAttachment));
  expect(screen.queryByRole('button', { name: 'error.logs.save' })).toBeNull();
  expect(api.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'error.logs.generate' }));
  await screen.findByText(preview.text);
  expect(screen.getByText('error.logs.missing')).toBeTruthy();
  expect(screen.getByText('error.logs.truncated')).toBeTruthy();
  expect(api.save).not.toHaveBeenCalled();
  api.save.mockResolvedValueOnce({ status: 'cancelled' });
  fireEvent.click(screen.getByRole('button', { name: 'error.logs.save' }));
  await screen.findByText('error.logs.cancelled');
  fireEvent.click(screen.getByRole('button', { name: 'error.logs.save' }));
  await screen.findByText('error.logs.saved');
  expect(api.save.mock.calls).toEqual([[{ id: preview.id }], [{ id: preview.id }]]);
  expect(api.prepare).toHaveBeenCalledTimes(1);
});

it('allows failure retry and discards a late preview after the error dialog closes', async () => {
  const view = render(createElement(DiagnosticLogAttachment));
  api.prepare.mockResolvedValueOnce({ status: 'failed' });
  fireEvent.click(screen.getByRole('button', { name: 'error.logs.generate' }));
  await screen.findByText('error.logs.failed');
  expect(screen.queryByRole('button', { name: 'error.logs.save' })).toBeNull();
  let resolve: (value: { status: 'ready'; preview: typeof preview }) => void = () => {};
  api.prepare.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'error.logs.generate' }));
  expect(screen.getByRole('button', { name: 'error.logs.generate' }).hasAttribute('disabled')).toBe(
    true,
  );
  view.unmount();
  await act(async () => {
    resolve({ status: 'ready', preview });
  });
  await waitFor(() => expect(api.discard).toHaveBeenCalledExactlyOnceWith({ id: preview.id }));
  expect(api.save).not.toHaveBeenCalled();
});
