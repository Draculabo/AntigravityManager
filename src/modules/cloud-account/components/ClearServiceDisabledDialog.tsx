import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import { QUERY_KEYS } from '@/modules/cloud-account/hooks/useCloudAccounts';

export function ClearServiceDisabledDialog({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    try {
      await ipc.client.cloud.clearServiceDisabled({ accountId });
      await client.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
      setOpen(false);
    } catch (error) {
      toast({
        error,
        title: t('cloud.card.clear-disabled-failed', 'Could not clear the account quarantine'),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t('cloud.card.clear-disabled', 'Clear quarantine')}
        </Button>
      </DialogTrigger>
      <DialogContent closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>
            {t('cloud.card.clear-disabled-title', 'Clear account quarantine?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'cloud.card.clear-disabled-description',
              'Only continue after Google has restored access. This clears the local block without checking Google; requests may resume and the account may be blocked again.',
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={confirm}>
            {t('cloud.card.clear-disabled-confirm', 'Clear local block')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
