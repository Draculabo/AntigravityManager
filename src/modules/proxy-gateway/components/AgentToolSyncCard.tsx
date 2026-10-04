import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { uniqBy } from 'lodash-es';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import {
  AgentToolConfigureSchema,
  AgentToolErrorCodeSchema,
  type AgentTool,
} from '../agent-tools/agent-tools.schema';
import { AgentToolCardFrame } from './AgentToolCardFrame';
import { isImageProxyExampleModel, type ProxyExampleModel } from './proxy-example-models';

interface Props {
  tool: AgentTool;
  baseUrl: string;
  models: readonly ProxyExampleModel[];
}
type Action = 'configure' | 'preview' | 'restore' | 'remove';
export function AgentToolSyncCard({ tool, baseUrl, models }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const title = tool === 'claude' ? 'Claude Code' : 'Codex';
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [model, setModel] = useState('');
  const [address, setAddress] = useState(baseUrl);
  const [preview, setPreview] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['gateway', 'agentTools', tool, baseUrl],
    queryFn: () => ipc.client.gateway.agentTools.status({ tool, baseUrl }),
  });
  const status = query.data;
  const choices = uniqBy(
    [
      ...models.filter((item) => !isImageProxyExampleModel(item.id)),
      ...(status?.isConfigured && status.model ? [{ id: status.model, name: status.model }] : []),
    ],
    'id',
  );
  const errorText = (error: unknown) => {
    const result = z
      .object({ data: z.object({ agentToolCode: AgentToolErrorCodeSchema }) })
      .safeParse(error);
    return result.success
      ? t(`agent-tools.errors.${result.data.data.agentToolCode}`)
      : t('agent-tools.action-error');
  };
  const open = async (next: Action) => {
    if (running.current) {
      return;
    }
    setAction(next);
    setModel((status?.isConfigured ? status.model : undefined) ?? choices[0]?.id ?? '');
    setAddress((status?.isConfigured ? status.currentBaseUrl : undefined) ?? baseUrl);
    if (next !== 'preview') {
      return;
    }
    setPreview(null);
    running.current = true;
    setBusy(true);
    try {
      setPreview((await ipc.client.gateway.agentTools.preview({ tool })).content);
    } catch (error) {
      toast({
        title: t('agent-tools.action-error'),
        description: errorText(error),
        variant: 'destructive',
      });
      setAction(null);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!action || running.current) {
      return;
    }
    const parsed = AgentToolConfigureSchema.safeParse({ tool, baseUrl: address, model });
    if (action === 'configure' && !parsed.success) {
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      switch (action) {
        case 'configure':
          if (parsed.success) {
            await ipc.client.gateway.agentTools.configure(parsed.data);
          }
          break;
        case 'restore':
          await ipc.client.gateway.agentTools.restore({ tool });
          break;
        case 'remove':
          await ipc.client.gateway.agentTools.remove({ tool });
          break;
        case 'preview':
          return;
      }
      setAction(null);
      await query.refetch();
      toast({
        title: t('agent-tools.saved'),
        description: t('agent-tools.reopen', { name: title }),
      });
    } catch (error) {
      toast({
        title: t('agent-tools.action-error'),
        description: errorText(error),
        variant: 'destructive',
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const invalid = !AgentToolConfigureSchema.safeParse({ tool, baseUrl: address, model }).success;
  return (
    <>
      <AgentToolCardFrame
        title={title}
        installed={status?.installed}
        version={status?.version}
        loading={query.isPending}
        failed={query.isError}
        configured={status?.isConfigured ?? false}
        synced={status?.isSynced ?? false}
        address={status?.currentBaseUrl}
        model={status?.model}
        retry={() => {
          void query.refetch();
        }}
      >
        <Button
          className="w-full"
          disabled={!status || query.isError || busy}
          onClick={() => {
            void open('configure');
          }}
        >
          {status?.isConfigured ? t('agent-tools.update') : t('agent-tools.configure')}
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!status?.exists || query.isError || busy}
            onClick={() => {
              void open('preview');
            }}
          >
            {t('agent-tools.view')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!status?.hasBackup || query.isError || busy}
            onClick={() => {
              void open('restore');
            }}
          >
            {t('agent-tools.restore')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!status?.isConfigured || query.isError || busy}
            onClick={() => {
              void open('remove');
            }}
          >
            {t('agent-tools.remove')}
          </Button>
        </div>
        {!status?.installed && !query.isPending && !query.isError ? (
          <p className="text-muted-foreground text-xs">{t('agent-tools.install-notice')}</p>
        ) : null}
      </AgentToolCardFrame>
      <Dialog
        open={action !== null}
        onOpenChange={(value) => {
          if (!busy && !value) {
            setAction(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(`agent-tools.${action ?? 'configure'}-title`, { name: title })}
            </DialogTitle>
            <DialogDescription>
              {t(`agent-tools.${action ?? 'configure'}-description`, { name: title })}
            </DialogDescription>
          </DialogHeader>
          {action === 'configure' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('agent-tools.model')}</Label>
                <Select value={model} onValueChange={setModel} disabled={busy}>
                  <SelectTrigger aria-label={t('agent-tools.model')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {tool === 'codex' ? (
                <p className="bg-muted rounded-lg p-3 text-sm">{t('agent-tools.codex-review')}</p>
              ) : null}
              <details>
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  {t('agent-tools.advanced')}
                </summary>
                <div className="mt-3 space-y-2">
                  <Label htmlFor={`${tool}-address`}>{t('agent-tools.address')}</Label>
                  <Input
                    id={`${tool}-address`}
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setAddress(baseUrl)}
                  >
                    {t('agent-tools.reset-address')}
                  </Button>
                  <p className="font-mono text-xs break-all">{status?.configPath}</p>
                  <p className="text-muted-foreground text-xs">{t('agent-tools.backend-files')}</p>
                </div>
              </details>
              <p className="text-muted-foreground text-xs">
                {t(tool === 'codex' ? 'agent-tools.toml-notice' : 'agent-tools.backup-notice')}
              </p>
            </div>
          ) : null}
          {action === 'preview' ? (
            <pre className="bg-muted max-h-[50vh] overflow-auto rounded-lg p-3 text-xs">
              {preview ?? t('agent-tools.loading')}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              {action === 'preview' ? t('common.close', 'Close') : t('common.cancel')}
            </Button>
            {action !== 'preview' ? (
              <Button
                disabled={busy || (action === 'configure' && invalid)}
                onClick={() => {
                  void submit();
                }}
              >
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {t('agent-tools.confirm')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
