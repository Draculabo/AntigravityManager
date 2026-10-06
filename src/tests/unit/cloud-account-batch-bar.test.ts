// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountBatchActionBar } from '@/modules/cloud-account/components/CloudAccountBatchActionBar';
import {
  AccountSelectionProvider,
  useAccountSelectionStore,
} from '@/modules/cloud-account/stores/AccountSelectionProvider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
afterEach(cleanup);

function renderBar(
  remove: (ids: string[]) => Promise<void>,
  refresh = vi.fn().mockResolvedValue(undefined),
) {
  function Page() {
    const store = useAccountSelectionStore();
    return createElement(
      'main',
      null,
      createElement(
        'button',
        {
          onClick: () => {
            store.getState().setSelected('visible', true);
            store.getState().setSelected('hidden', true);
          },
        },
        'Select accounts',
      ),
      createElement(CloudAccountBatchActionBar, {
        visibleAccountIds: ['visible'],
        onDeleteSelected: remove,
        onRefreshSelected: refresh,
      }),
    );
  }
  render(createElement(AccountSelectionProvider, null, createElement(Page)));
  fireEvent.click(screen.getByRole('button', { name: 'Select accounts' }));
}

describe('batch account toolbar', () => {
  it('requires confirmation, preserves selection on cancellation and returns focus', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    renderBar(remove);
    const trigger = screen.getByRole('button', { name: 'cloud.batch.delete' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog').textContent).toContain('cloud.batch.confirmDelete:1');
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.batch.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('cloud.batch.selected:1')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('sends only the visible snapshot once while deletion is pending', async () => {
    const pending = Promise.withResolvers<void>();
    const remove = vi.fn().mockReturnValue(pending.promise);
    renderBar(remove);
    fireEvent.click(screen.getByRole('button', { name: 'cloud.batch.delete' }));
    const confirm = screen.getAllByRole('button', { name: 'cloud.batch.delete' }).at(-1)!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(remove.mock.calls).toEqual([[['visible']]]);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
