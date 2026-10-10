import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { uniqBy } from 'lodash-es';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
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
  const modelId = useId();
  const addressHelpId = useId();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [model, setModel] = useState('');
  const [address, setAddress] = useState(baseUrl);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
    setPreviewError(null);
    running.current = true;
    setBusy(true);
    try {
      setPreview((await ipc.client.gateway.agentTools.preview({ tool })).content);
    } catch (error) {
      setPreviewError(errorText(error));
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
        variant: 'success',
        description: t('agent-tools.reopen', { name: title }),
      });
    } catch (error) {
      toast({
        error,
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
  const invalidAddress = !AgentToolConfigureSchema.shape.baseUrl.safeParse(address).success;
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
        <DialogContent
          closeDisabled={busy}
          aria-busy={busy}
          className="flex flex-col gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
            <DialogTitle>
              {t(`agent-tools.${action ?? 'configure'}-title`, { name: title })}
            </DialogTitle>
            <DialogDescription>
              {t(`agent-tools.${action ?? 'configure'}-description`, { name: title })}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {action === 'configure' ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={modelId}>{t('agent-tools.model')}</Label>
                  <Select value={model} onValueChange={setModel} disabled={busy}>
                    <SelectTrigger id={modelId} aria-label={t('agent-tools.model')}>
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
                  {!model && (
                    <p role="status" className="text-warning text-xs">
                      {t('agent-tools.model-required')}
                    </p>
                  )}
                </div>
                {tool === 'codex' ? (
                  <p className="bg-muted rounded-lg p-3 text-sm">{t('agent-tools.codex-review')}</p>
                ) : null}
                <details>
                  <summary className="text-muted-foreground focus-visible:ring-ring cursor-default rounded-sm text-sm outline-none focus-visible:ring-2">
                    {t('agent-tools.advanced')}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <Label htmlFor={`${tool}-address`}>{t('agent-tools.address')}</Label>
                    <Input
                      id={`${tool}-address`}
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      disabled={busy}
                      aria-invalid={invalidAddress}
                      aria-describedby={addressHelpId}
                      spellCheck={false}
                    />
                    <p
                      id={addressHelpId}
                      role={invalidAddress ? 'alert' : undefined}
                      className={
                        invalidAddress
                          ? 'text-destructive text-xs'
                          : 'text-muted-foreground text-xs'
                      }
                    >
                      {t(
                        invalidAddress ? 'agent-tools.invalid-address' : 'agent-tools.address-help',
                      )}
                    </p>
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
                    <p className="text-muted-foreground text-xs">
                      {t('agent-tools.backend-files')}
                    </p>
                  </div>
                </details>
                <p className="text-muted-foreground text-xs">
                  {t(tool === 'codex' ? 'agent-tools.toml-notice' : 'agent-tools.backup-notice')}
                </p>
              </div>
            ) : null}
            {action === 'preview' ? (
              busy ? (
                <FeedbackState
                  kind="loading"
                  title={t('agent-tools.loading')}
                  description={t('common.reading-settings')}
                />
              ) : previewError ? (
                <FeedbackState
                  kind="error"
                  title={t('agent-tools.errors.read-failed')}
                  description={previewError}
                >
                  <Button variant="outline" onClick={() => void open('preview')}>
                    {t('action.retry')}
                  </Button>
                </FeedbackState>
              ) : (
                <pre className="bg-muted overflow-auto rounded-md border p-4 font-mono text-xs leading-relaxed">
                  {preview}
                </pre>
              )
            ) : null}
          </div>
          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              {action === 'preview' ? t('common.close', 'Close') : t('common.cancel')}
            </Button>
            {action !== 'preview' ? (
              <Button
                disabled={busy || (action === 'configure' && invalid)}
                aria-busy={busy}
                variant={action === 'restore' || action === 'remove' ? 'destructive' : 'default'}
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
