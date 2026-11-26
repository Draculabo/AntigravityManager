import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, DatabaseZap, KeyRound, Plus } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/use-toast';
import { QUERY_KEYS } from '../hooks/useCloudAccounts';
import { LocalAccountImportPanel } from '../local-import/components/LocalAccountImportDialog';
import { CloudAccountOAuthPanel } from './CloudAccountOAuthPanel';
import { CloudAccountCredentialImportPanel } from './CloudAccountCredentialImportPanel';

const methods = [
  { id: 'google', icon: Cloud },
  { id: 'credentials', icon: KeyRound },
  { id: 'local', icon: DatabaseZap },
] as const;

type AddMethod = (typeof methods)[number]['id'];

export function CloudAccountLoginDialog() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<AddMethod>('google');
  const [importing, setImporting] = useState(false);
  const sessionQueueRef = useRef(Promise.resolve());

  const accountSaved = useCallback(
    (isCurrent: boolean) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
      if (isCurrent) {
        setOpen(false);
        toast({ title: t('cloud.toast.addSuccess'), variant: 'success' });
      }
    },
    [queryClient, t, toast],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!importing) {
          setOpen(nextOpen);
          if (nextOpen) {
            setMethod('google');
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" className="size-4" />
          {t('cloud.addAccount')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl" closeDisabled={importing}>
        <DialogHeader>
          <DialogTitle>{t('cloud.addAccount')}</DialogTitle>
          <DialogDescription>{t('cloud.add-flow.description')}</DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs
            value={method}
            onValueChange={(value) => {
              const next = methods.find(({ id }) => id === value);
              if (next && !importing) {
                setMethod(next.id);
              }
            }}
            activationMode="manual"
          >
            <TabsList className="grid w-full grid-cols-3" aria-label={t('cloud.add-flow.methods')}>
              {methods.map(({ id, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  disabled={importing && id !== method}
                  className="gap-1.5 px-1 text-xs sm:text-sm"
                >
                  <Icon aria-hidden="true" className="hidden size-4 sm:block" />
                  {t(`cloud.add-flow.tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="google" className="mt-4">
              {method === 'google' && (
                <CloudAccountOAuthPanel
                  sessionQueueRef={sessionQueueRef}
                  onAuthorized={accountSaved}
                />
              )}
            </TabsContent>
            <TabsContent value="credentials" className="mt-4">
              {method === 'credentials' && (
                <CloudAccountCredentialImportPanel
                  onBusyChange={setImporting}
                  onComplete={() => setOpen(false)}
                />
              )}
            </TabsContent>
            <TabsContent value="local" className="mt-4">
              {method === 'local' && <LocalAccountImportPanel onBusyChange={setImporting} />}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
