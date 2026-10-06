import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountSelectionProvider,
  useAccountSelectionStore,
} from '@/modules/cloud-account/stores/AccountSelectionProvider';
import { useCloudAccountBatchActions } from '@/modules/cloud-account/hooks/useCloudAccountBatchActions';
import {
  useRefreshQuota,
  useDeleteCloudAccount,
} from '@/modules/cloud-account/hooks/useCloudAccounts';

const mocks = vi.hoisted(() => ({
  refreshAccountQuota: vi.fn(),
  deleteCloudAccount: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => mocks);
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: object) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('@/shared/utils/errorMessages', () => ({
  getLocalizedErrorMessage: () => 'Request failed',
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function renderBatchActions() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(client);
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client },
      createElement(AccountSelectionProvider, null, children),
    );
  }
  return renderHook(
    () => {
      const store = useAccountSelectionStore();
      const refreshMutation = useRefreshQuota();
      const deleteMutation = useDeleteCloudAccount();
      return {
        store,
        ...useCloudAccountBatchActions({
          visibleAccountIds: ['visible-1', 'visible-2'],
          refreshMutation,
          deleteMutation,
        }),
      };
    },
    { wrapper: Wrapper },
  );
}

describe('batch account actions', () => {
  it('reads the latest visible selection at click time and reports refresh failures', async () => {
    mocks.refreshAccountQuota
      .mockRejectedValueOnce(new Error('Synthetic failure'))
      .mockResolvedValueOnce({ id: 'visible-1' });
    const { result } = renderBatchActions();
    const refresh = result.current.refreshSelectedAccounts;
    act(() => {
      result.current.store.getState().setSelected('hidden', true);
      result.current.store.getState().setSelected('visible-2', true);
      result.current.store.getState().setSelected('visible-1', true);
    });
    await act(async () => refresh());
    expect(mocks.refreshAccountQuota.mock.calls.map(([input]) => input)).toEqual([
      { accountId: 'visible-2' },
      { accountId: 'visible-1' },
    ]);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'cloud.toast.batchRefreshPartial.title',
      description:
        'cloud.toast.batchRefreshPartial.description:{"successful":1,"failed":1} Request failed',
      variant: 'warning',
    });
    expect(Array.from(result.current.store.getState().selectedIds)).toEqual([]);
  });

  it('deletes the confirmed snapshot, then clears the selection', async () => {
    mocks.deleteCloudAccount.mockResolvedValue(undefined);
    const { result } = renderBatchActions();
    const remove = result.current.deleteSelectedAccounts;
    act(() => {
      result.current.store.getState().setSelected('hidden', true);
      result.current.store.getState().setSelected('visible-2', true);
    });
    await act(async () => remove(['visible-1']));
    expect(mocks.deleteCloudAccount.mock.calls.map(([input]) => input)).toEqual([
      { accountId: 'visible-1' },
    ]);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'cloud.toast.deleted',
      description: 'cloud.toast.batchDeleteSuccess:{"count":1}',
      variant: 'success',
    });
    expect(Array.from(result.current.store.getState().selectedIds)).toEqual([]);
  });
});
