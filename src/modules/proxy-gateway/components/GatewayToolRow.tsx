import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { gatewayToolNames } from './gateway-tool-defaults';
import { nativeToolConnections } from './gateway-tool-native-connection';
import {
  applyToolProfile,
  connectToolProfile,
  useGatewayToolProfiles,
} from './gateway-tool-profiles';
import { readClientConfigFailure } from './client-config-failure';

type Tool = keyof typeof gatewayToolNames;
type Action = 'connect' | 'disconnect' | 'restore' | 'revoke';

const dialogCopy = {
  view: ['agent-tools.preview-title', 'agent-tools.preview-description'],
  connect: ['agent-tools.configure-title', 'agent-tools.configure-description'],
  disconnect: ['agent-tools.remove-title', 'client-config.tool-disconnect-description'],
  restore: ['agent-tools.restore-title', 'agent-tools.restore-description'],
  revoke: ['agent-tools.revoke-key', 'client-config.tool-revoke-description'],
} as const;

export function GatewayToolRow({
  tool,
  baseUrl,
  models,
  hasGatewayKey,
}: {
  tool: Tool;
  baseUrl: string;
  models: readonly string[];
  hasGatewayKey: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const name = gatewayToolNames[tool];
  const adapter = nativeToolConnections[tool];
  const profiles = useGatewayToolProfiles();
  const native = useQuery({
    queryKey: ['gateway', 'tool-connection', tool, baseUrl],
    queryFn: () => adapter?.status(baseUrl),
    enabled: Boolean(adapter),
    retry: false,
  });
  const toolProfiles = profiles.data?.filter((profile) => profile.client === tool) ?? [];
  const applied = toolProfiles.filter((profile) => profile.applied);
  const connected = native.data?.connected || applied.length > 0;
  const loading = profiles.isPending || (Boolean(adapter) && native.isPending);
  const [dialog, setDialog] = useState<Action | 'view' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const running = useRef(false);
  const preview = useQuery({
    queryKey: ['gateway', 'tool-preview', tool],
    queryFn: () => adapter?.view?.(),
    enabled: dialog === 'view' && Boolean(adapter?.view),
    retry: false,
  });
  const couldDisconnect = connected && profiles.isSuccess;
  const couldConnect =
    profiles.isSuccess &&
    !connected &&
    Boolean(models[0]) &&
    (hasGatewayKey || tool === 'opencode') &&
    (!adapter || (native.isSuccess && native.data?.available));

  async function reload() {
    await Promise.all([profiles.refetch(), adapter ? native.refetch() : undefined]);
  }

  async function run(action: Action) {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      switch (action) {
        case 'connect': {
          const model = models[0];
          if (!couldConnect || !model) {
            return;
          }
          if (adapter) {
            await adapter.connect(baseUrl, model, models);
          } else {
            await connectToolProfile(tool, baseUrl, model, models, toolProfiles);
          }
          break;
        }
        case 'disconnect':
          if (!couldDisconnect) {
            return;
          }
          // Removing the saved connection first can restore fields owned by the native connection.
          for (const profile of applied) {
            await applyToolProfile(profile.id, 'remove');
          }
          if (adapter && (await adapter.status(baseUrl)).connected) {
            await adapter.disconnect(baseUrl);
          }
          break;
        case 'restore':
          if (!profiles.isSuccess || applied.length || !adapter?.restore) {
            return;
          }
          await adapter.restore();
          break;
        case 'revoke':
          if (!profiles.isSuccess || applied.length || !adapter?.revoke) {
            return;
          }
          await adapter.revoke();
          break;
      }
      toast({
        title: t('agent-tools.saved'),
        description: action === 'revoke' ? undefined : t('agent-tools.reopen', { name }),
        variant: 'success',
      });
      setDialog(null);
    } catch (error) {
      setFailure(t('client-config.' + readClientConfigFailure(error)));
      setDialog(null);
    } finally {
      await reload();
      setBusy(false);
      running.current = false;
    }
  }

  const hasError = profiles.isError || native.isError;
  const canRestore = profiles.isSuccess && !applied.length && native.data?.hasBackup;
  const canRevoke = profiles.isSuccess && !applied.length && native.data?.canRevoke;
  const action = connected ? 'disconnect' : 'connect';
  const actionLabel = t(connected ? 'client-config.tool-disconnect' : 'client-config.tool-connect');
  const status =
    hasError && !couldDisconnect
      ? t('client-config.tool-status-unavailable')
      : connected
        ? t('client-config.connection-unverified')
        : loading
          ? t('agent-tools.loading')
          : native.data?.available === false
            ? t('client-config.quick-dsh-missing')
            : native.data?.replacement
              ? t('agent-tools.custom-address')
              : t('client-config.tool-disconnected');

  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-sm font-semibold">
            {name}
          </h3>
          <p className="text-muted-foreground text-xs">{status}</p>
        </div>
        <div className="grid shrink-0 grid-cols-[minmax(5.5rem,auto)_2.25rem] items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={connected ? 'outline' : 'default'}
            aria-describedby={id}
            disabled={busy || ((connected ? !couldDisconnect : !couldConnect) && !hasError)}
            onClick={() => {
              if (hasError && !couldDisconnect) {
                void reload();
              } else if (
                (action === 'connect' && native.data?.replacement) ||
                (action === 'disconnect' &&
                  (applied.length > 1 || (applied.length > 0 && native.data?.connected)))
              ) {
                setDialog(action);
              } else {
                void run(action);
              }
            }}
          >
            {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {hasError && !couldDisconnect ? t('agent-tools.retry') : actionLabel}
          </Button>
          {native.data?.canView || canRestore || canRevoke ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('client-config.tool-more', { name })}
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {native.data?.canView && (
                  <DropdownMenuItem onSelect={() => setDialog('view')}>
                    {t('agent-tools.view')}
                  </DropdownMenuItem>
                )}
                {canRestore && (
                  <DropdownMenuItem onSelect={() => setDialog('restore')}>
                    {t('agent-tools.restore')}
                  </DropdownMenuItem>
                )}
                {canRevoke && (
                  <DropdownMenuItem onSelect={() => setDialog('revoke')}>
                    {t('agent-tools.revoke-key')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {failure && (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDialog(null);
          }
        }}
      >
        {dialog && (
          <DialogContent closeDisabled={busy}>
            <DialogHeader>
              <DialogTitle>{t(dialogCopy[dialog][0], { name })}</DialogTitle>
              <DialogDescription>{t(dialogCopy[dialog][1], { name })}</DialogDescription>
            </DialogHeader>
            {dialog === 'view' &&
              (preview.isPending ? (
                <p role="status">{t('agent-tools.loading')}</p>
              ) : preview.isError ? (
                <div>
                  <p role="alert">{t('agent-tools.read-error')}</p>
                  <Button variant="outline" onClick={() => void preview.refetch()}>
                    {t('agent-tools.retry')}
                  </Button>
                </div>
              ) : (
                <div className="min-w-0 space-y-2">
                  <p className="text-muted-foreground text-xs break-all">
                    {preview.data?.configPath}
                  </p>
                  <pre className="max-h-[55vh] overflow-auto rounded-md border p-3 text-xs">
                    {preview.data?.content}
                  </pre>
                </div>
              ))}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t(dialog === 'view' ? 'common.close' : 'common.cancel')}
              </Button>
              {dialog !== 'view' && (
                <Button
                  type="button"
                  variant={dialog === 'connect' ? 'default' : 'destructive'}
                  disabled={busy}
                  onClick={() => void run(dialog)}
                >
                  {t('agent-tools.confirm')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
