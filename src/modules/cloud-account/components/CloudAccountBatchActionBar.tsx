import { useRef, useState } from 'react';
import { useAccountSelection, useAccountSelectionStore } from '../stores/AccountSelectionProvider';
import { getSelectedVisibleAccountIds } from '../stores/account-selection';
import { Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface CloudAccountBatchActionBarProps {
  visibleAccountIds: string[];
  onRefreshSelected: () => Promise<void>;
  onDeleteSelected: (accountIds: string[]) => Promise<void>;
}

export function CloudAccountBatchActionBar({
  visibleAccountIds,
  onRefreshSelected,
  onDeleteSelected,
}: CloudAccountBatchActionBarProps) {
  const { t } = useTranslation();
  const store = useAccountSelectionStore();
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [pending, setPending] = useState<'refresh' | 'delete' | null>(null);
  const operationPending = useRef(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const selectedCount = useAccountSelection(
    (state) => visibleAccountIds.filter((id) => state.selectedIds.has(id)).length,
  );
  const onClearSelection = useAccountSelection((state) => state.clear);

  const runAction = async (action: 'refresh' | 'delete') => {
    if (operationPending.current) {
      return;
    }
    operationPending.current = true;
    setPending(action);
    try {
      if (action === 'refresh') {
        await onRefreshSelected();
      } else {
        await onDeleteSelected(deleteIds);
        setDeleteIds([]);
      }
    } finally {
      operationPending.current = false;
      setPending(null);
    }
  };

  if (selectedCount === 0 && deleteIds.length === 0 && !pending) {
    return null;
  }

  return (
    <>
      <div
        role="region"
        aria-label={t('cloud.batch.actions')}
        aria-busy={pending !== null}
        className="bg-card sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-3 rounded-lg border px-4 py-3 shadow-md"
      >
        <div className="flex items-center gap-2 border-r pr-4">
          <span className="text-sm font-semibold">
            {t('cloud.batch.selected', { count: selectedCount })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-full"
            onClick={onClearSelection}
            disabled={pending !== null}
            aria-label={t('cloud.batch.clear')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runAction('refresh')}
            disabled={pending !== null}
          >
            {pending === 'refresh' ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3 w-3" />
            )}
            {t('cloud.batch.refresh')}
          </Button>
          <Button
            ref={deleteButton}
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() =>
              setDeleteIds(
                getSelectedVisibleAccountIds(store.getState().selectedIds, visibleAccountIds),
              )
            }
          >
            <Trash2 className="mr-2 h-3 w-3" />
            {t('cloud.batch.delete')}
          </Button>
        </div>
      </div>
      <Dialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open && !operationPending.current) {
            setDeleteIds([]);
          }
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            deleteButton.current?.focus();
          }}
        >
          <DialogHeader className="pr-8">
            <DialogTitle>{t('cloud.batch.delete-title', { count: deleteIds.length })}</DialogTitle>
            <DialogDescription>
              {t('cloud.batch.confirmDelete', { count: deleteIds.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              disabled={pending !== null}
              onClick={() => setDeleteIds([])}
            >
              {t('cloud.batch.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending !== null}
              aria-busy={pending === 'delete'}
              onClick={() => runAction('delete')}
            >
              {pending === 'delete' && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('cloud.batch.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
