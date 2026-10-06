import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import type { useRefreshQuota, useDeleteCloudAccount } from './useCloudAccounts';
import { useAccountSelectionStore } from '../stores/AccountSelectionProvider';
import { getSelectedVisibleAccountIds } from '../stores/account-selection';

interface BatchActionsInput {
  visibleAccountIds: string[];
  refreshMutation: ReturnType<typeof useRefreshQuota>;
  deleteMutation: ReturnType<typeof useDeleteCloudAccount>;
}

export function useCloudAccountBatchActions({
  visibleAccountIds,
  refreshMutation,
  deleteMutation,
}: BatchActionsInput) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const selectionStore = useAccountSelectionStore();
  const refreshSelectedAccounts = async () => {
    const ids = getSelectedVisibleAccountIds(
      selectionStore.getState().selectedIds,
      visibleAccountIds,
    );
    const results = await Promise.allSettled(
      ids.map((id) => refreshMutation.mutateAsync({ accountId: id })),
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed === 0) {
      toast({
        title: t('cloud.toast.quotaRefreshed'),
        description: t('cloud.toast.batchRefreshSuccess', { count: successful }),
        variant: 'success',
      });
    } else {
      const firstRejectedResult = results.find((result) => result.status === 'rejected');
      const firstFailureMessage =
        firstRejectedResult?.status === 'rejected'
          ? getLocalizedErrorMessage(firstRejectedResult.reason, t)
          : null;

      toast({
        title: t('cloud.toast.batchRefreshPartial.title'),
        description: firstFailureMessage
          ? `${t('cloud.toast.batchRefreshPartial.description', {
              successful,
              failed,
            })} ${firstFailureMessage}`
          : t('cloud.toast.batchRefreshPartial.description', {
              successful,
              failed,
            }),
        variant: successful > 0 ? 'warning' : 'destructive',
      });
    }

    selectionStore.getState().clear();
  };

  const deleteSelectedAccounts = async (ids: string[]) => {
    const results = await Promise.allSettled(
      ids.map((id) => deleteMutation.mutateAsync({ accountId: id })),
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed === 0) {
      toast({
        title: t('cloud.toast.deleted'),
        description: t('cloud.toast.batchDeleteSuccess', { count: successful }),
        variant: 'success',
      });
    } else {
      toast({
        title: t('cloud.toast.batchDeletePartial.title'),
        description: t('cloud.toast.batchDeletePartial.description', {
          successful,
          failed,
        }),
        variant: successful > 0 ? 'warning' : 'destructive',
      });
    }

    selectionStore.getState().clear();
  };

  return { refreshSelectedAccounts, deleteSelectedAccounts };
}
