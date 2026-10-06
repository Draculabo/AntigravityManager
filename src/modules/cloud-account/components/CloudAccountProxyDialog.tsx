import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CloudAccountProxyEditor } from './CloudAccountProxyEditor';

export function CloudAccountProxyDialog({
  accountId,
  configured,
}: {
  accountId: string;
  configured: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={`h-7 w-7 ${configured ? 'text-primary' : ''}`}
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
      </DialogContent>
    </Dialog>
  );
}
