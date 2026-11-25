import { Network } from 'lucide-react';
import { useId, useState } from 'react';
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
import {
  SetCloudAccountRoutingInputSchema,
  type CloudAccountProxyPriorityOverrides,
} from '../services/cloud-account-routing.schema';

const priorityFields = ['global', 'gemini', 'claude'] as const;

export function CloudAccountProxyDialog({
  accountId,
  configured,
  proxyPriority,
  proxyPriorityOverrides,
  proxyEnabled,
}: {
  accountId: string;
  configured: boolean;
  proxyPriority: number;
  proxyPriorityOverrides?: CloudAccountProxyPriorityOverrides;
  proxyEnabled: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const setRouting = useSetAccountRouting();
  const id = useId();
  const [open, setOpen] = useState(false);
  const saved = {
    global: String(proxyPriority),
    gemini: proxyPriorityOverrides?.gemini?.toString() ?? '',
    claude: proxyPriorityOverrides?.claude?.toString() ?? '',
  };
  const [priorities, setPriorities] = useState(saved);
  const [enabled, setEnabled] = useState(proxyEnabled);
  const changed =
    enabled !== proxyEnabled || priorityFields.some((field) => priorities[field] !== saved[field]);

  const saveRouting = () => {
    const parsed = SetCloudAccountRoutingInputSchema.safeParse({
      accountId,
      proxyPriority: Number(priorities.global),
      proxyEnabled: enabled,
      proxyPriorityOverrides: {
        ...(priorities.gemini !== '' && { gemini: Number(priorities.gemini) }),
        ...(priorities.claude !== '' && { claude: Number(priorities.claude) }),
      },
    });
    if (!parsed.success) {
      toast({ title: t('cloud.card.proxy-routing-save-failed'), variant: 'destructive' });
      return;
    }
    setRouting.mutate(parsed.data, {
      onSuccess: () => setOpen(false),
      onError: (error) =>
        toast({
          title: t('cloud.card.proxy-routing-save-failed'),
          variant: 'destructive',
          error,
        }),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setPriorities(saved);
          setEnabled(proxyEnabled);
        }
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          className={`hover:bg-muted border-transparent bg-transparent hover:border-transparent ${configured ? 'text-primary' : ''}`}
          aria-label={t('cloud.card.network-proxy')}
          title={t('cloud.card.network-proxy')}
          disabled={setRouting.isPending}
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
        <form
          className="space-y-3 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && !setRouting.isPending) {
              saveRouting();
            }
          }}
        >
          <p id={`${id}-priority-hint`} className="text-muted-foreground text-sm">
            {t('cloud.card.proxy-family-priority-hint')}
          </p>
          {priorityFields.map((field) => (
            <div key={field} className="flex items-center justify-between gap-3">
              <label htmlFor={`${id}-${field}`} className="text-sm">
                {field === 'global'
                  ? t('cloud.card.proxy-priority')
                  : t(`cloud.card.proxy-priority-${field}`)}
              </label>
              <Input
                id={`${id}-${field}`}
                aria-describedby={`${id}-priority-hint`}
                type="number"
                min={1}
                max={100}
                required={field === 'global'}
                value={priorities[field]}
                placeholder={field === 'global' ? undefined : priorities.global}
                onChange={(event) => setPriorities({ ...priorities, [field]: event.target.value })}
                className="h-8 w-24 shrink-0"
                disabled={setRouting.isPending}
              />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
              disabled={setRouting.isPending}
            />
            {t('cloud.card.proxy-enabled')}
          </label>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!changed || setRouting.isPending}>
              {t('cloud.card.proxy-routing-save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
