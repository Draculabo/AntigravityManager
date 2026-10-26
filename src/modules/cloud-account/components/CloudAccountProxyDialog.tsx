import { Network } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CloudAccountProxyEditor } from './CloudAccountProxyEditor';
import { useSetAccountRouting } from '@/modules/cloud-account/hooks/useCloudAccounts';

export function CloudAccountProxyDialog({
  accountId,
  configured,
  proxyPriority,
  proxyEnabled,
}: {
  accountId: string;
  configured: boolean;
  proxyPriority: number;
  proxyEnabled: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const setRouting = useSetAccountRouting();
  const [priority, setPriority] = useState(String(proxyPriority));
  const [enabled, setEnabled] = useState(proxyEnabled);

  const saveRouting = (nextPriority = priority, nextEnabled = enabled) => {
    const parsedPriority = Number(nextPriority);
    if (!Number.isInteger(parsedPriority) || parsedPriority < 1 || parsedPriority > 100) {
      toast({ title: t('cloud.card.proxy-routing-save-failed'), variant: 'destructive' });
      return;
    }
    setRouting.mutate(
      { accountId, proxyPriority: parsedPriority, proxyEnabled: nextEnabled },
      {
        onError: (error) =>
          toast({
            title: t('cloud.card.proxy-routing-save-failed'),
            variant: 'destructive',
            error,
          }),
      },
    );
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          className={`hover:bg-muted border-transparent bg-transparent hover:border-transparent ${configured ? 'text-primary' : ''}`}
          aria-label={t('cloud.card.network-proxy')}
          title={t('cloud.card.network-proxy')}
        >
          <Network aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cloud.card.network-proxy')}</DialogTitle>
          <DialogDescription>{t('cloud.card.network-proxy-description')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <CloudAccountProxyEditor accountId={accountId} configured={configured} />
        </div>
        <div className="space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`proxy-priority-${accountId}`} className="text-sm">
              {t('cloud.card.proxy-priority')}
            </label>
            <Input
              id={`proxy-priority-${accountId}`}
              type="number"
              min={1}
              max={100}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              onBlur={() => saveRouting()}
              className="h-8 w-24"
              disabled={setRouting.isPending}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(checked) => {
                const nextEnabled = checked === true;
                setEnabled(nextEnabled);
                saveRouting(priority, nextEnabled);
              }}
              disabled={setRouting.isPending}
            />
            {t('cloud.card.proxy-enabled')}
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
