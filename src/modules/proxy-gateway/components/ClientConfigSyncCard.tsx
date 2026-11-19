import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readClientConfigFailure } from './client-config-failure';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { NativeClientSetupCard, type ToolManagement } from './NativeClientSetupCard';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ClientConfigPreviewInputSchema,
  type ClientConfigPlan,
} from '../agent-tools/client-config.schema';

type Client = 'hermes' | 'openclaw';
type Review = {
  plan: ClientConfigPlan;
  result: Awaited<ReturnType<typeof ipc.client.gateway.clientConfig.preview>>;
};
type ReviewedAction = { kind: 'quick'; plan: ClientConfigPlan } | ({ kind: 'reviewed' } & Review);

export function ClientConfigSyncCard({
  client,
  baseUrl,
  quickModels = [],
  management,
}: {
  client: Client;
  baseUrl: string;
  quickModels?: readonly string[];
  management?: ToolManagement;
}) {
  const { t } = useTranslation();
  const id = useId();
  const name = client === 'hermes' ? 'Hermes' : 'OpenClaw';
  const [address, setAddress] = useState(baseUrl);
  const [models, setModels] = useState('');
  const [activate, setActivate] = useState(false);
  const [activateModel, setActivateModel] = useState('');
  const [discoverModels, setDiscoverModels] = useState(true);
  const [version, setVersion] = useState('v2');
  const [mergeModels, setMergeModels] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    | 'saved-client'
    | 'connection-removed'
    | 'invalid-client'
    | ReturnType<typeof readClientConfigFailure>
    | null
  >(null);
  const pending = useRef(false);
  const quickModel = quickModels[0];
  const allowActivation = !management?.blocksNativeActivation?.();
  const status = useQuery({
    queryKey: ['gateway', 'clientConfig', client],
    queryFn: async () => {
      const installation = await ipc.client.gateway.clientConfig.status({ client });
      try {
        const removal = installation.exists
          ? await ipc.client.gateway.clientConfig.preview({ client, action: 'remove' })
          : undefined;
        return { ...installation, managed: removal?.changed === true, ownershipError: null };
      } catch (error) {
        return { ...installation, managed: false, ownershipError: readClientConfigFailure(error) };
      }
    },
    retry: false,
  });
  const edit = (change: () => void) => {
    change();
    setReview(null);
    setNotice(null);
  };
  const preview = async (action: 'sync' | 'remove') => {
    if (pending.current || (action === 'sync' && management?.nativeSetupBlocked)) {
      return;
    }
    const modelIds = [
      ...new Set(
        models
          .split(/[\n,]/u)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const parsed = ClientConfigPreviewInputSchema.safeParse(
      action === 'remove'
        ? { client, action }
        : {
            client,
            action,
            baseUrl: address,
            models: modelIds,
            activateModel: activate && allowActivation ? activateModel : null,
            ...(client === 'hermes'
              ? { discoverModels }
              : { version, modelsMode: mergeModels ? 'merge' : 'preserve' }),
          },
    );
    setReview(null);
    if (!parsed.success) {
      setNotice('invalid-client');
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await ipc.client.gateway.clientConfig.preview(parsed.data);
      setReview({ plan: parsed.data, result });
    } catch (error) {
      setNotice(readClientConfigFailure(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const apply = async (plan: ReviewedAction) => {
    if (
      pending.current ||
      (plan.plan.action === 'sync' &&
        (management?.nativeSetupBlocked || (plan.plan.activateModel && !allowActivation)))
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setReview(null);
    try {
      const result =
        plan.kind === 'quick'
          ? await ipc.client.gateway.clientConfig.preview(plan.plan)
          : plan.result;
      await ipc.client.gateway.clientConfig.mutate({
        plan: plan.plan,
        expectedSourceHash: result.sourceHash,
      });
      setNotice(plan.plan.action === 'remove' ? 'connection-removed' : 'saved-client');
    } catch (error) {
      setNotice(readClientConfigFailure(error));
    } finally {
      await status.refetch();
      pending.current = false;
      setBusy(false);
    }
  };
  const configure = () => {
    if (!quickModel) {
      return;
    }
    const defaults = {
      action: 'sync' as const,
      baseUrl,
      models: quickModels.slice(0, 256),
      activateModel: quickModel,
    };
    const plan: ClientConfigPlan =
      client === 'hermes'
        ? { ...defaults, client, discoverModels: true }
        : { ...defaults, client, version: 'v2', modelsMode: 'preserve' };
    void apply({ kind: 'quick', plan });
  };
  return (
    <NativeClientSetupCard
      name={name}
      defaultModel={quickModel}
      management={management}
      configured={status.data?.managed}
      status={
        status.isPending
          ? t('agent-tools.loading')
          : status.data?.managed
            ? t('client-config.connection-unverified')
            : undefined
      }
      busy={busy}
      ready={status.isSuccess && !status.data.ownershipError}
      onConfigure={configure}
      feedback={
        notice ? (
          <p
            role={notice === 'saved-client' || notice === 'connection-removed' ? 'status' : 'alert'}
            className="text-sm"
          >
            {t('client-config.' + notice, { name })}
          </p>
        ) : status.data?.ownershipError ? (
          <p role="alert" className="text-sm">
            {t('client-config.' + status.data.ownershipError)}
          </p>
        ) : status.isError ? (
          <p role="alert" className="text-sm">
            {t('client-config.client-read-failed')}
          </p>
        ) : null
      }
    >
      <div aria-live="polite" className="text-muted-foreground space-y-1 text-xs">
        {status.isFetching ? <p>{t('agent-tools.loading')}</p> : null}
        {status.data && !status.isError ? (
          <>
            <p>
              {status.data.installed
                ? (status.data.version ?? t('client-config.version-unknown'))
                : t('agent-tools.not-installed')}
            </p>
            <p className="break-all">{status.data.configPath}</p>
            <p>
              {t(
                status.data.exists
                  ? 'client-config.profile-found'
                  : 'client-config.profile-missing',
              )}
            </p>
          </>
        ) : null}
        {status.isError ? <p role="alert">{t('client-config.client-read-failed')}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !status.data?.exists}
          onClick={() => void preview('remove')}
        >
          {t('agent-tools.remove')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void status.refetch()}>
          {t('agent-tools.retry')}
        </Button>
      </div>
      <details className="space-y-3">
        <summary className="text-sm font-medium">{t('client-config.edit-settings')}</summary>
        <fieldset disabled={busy} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={id + '-address'}>{t('agent-tools.address')}</Label>
            <Input
              id={id + '-address'}
              value={address}
              onChange={(event) => edit(() => setAddress(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id + '-models'}>{t('client-config.model-ids')}</Label>
            <Textarea
              id={id + '-models'}
              value={models}
              onChange={(event) => edit(() => setModels(event.target.value))}
            />
          </div>
          {client === 'hermes' ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={id + '-discover'}
                checked={discoverModels}
                onCheckedChange={(value) => edit(() => setDiscoverModels(value === true))}
              />
              <Label htmlFor={id + '-discover'}>{t('client-config.discover-models')}</Label>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor={id + '-version'}>{t('client-config.openclaw-version')}</Label>
              <Select value={version} onValueChange={(value) => edit(() => setVersion(value))}>
                <SelectTrigger id={id + '-version'}>
                  <SelectValue placeholder={t('client-config.choose-version')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="v1">v1</SelectItem>
                  <SelectItem value="v2">v2</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{t('client-config.version-help')}</p>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={id + '-merge'}
                  checked={mergeModels}
                  onCheckedChange={(value) => edit(() => setMergeModels(value === true))}
                />
                <Label htmlFor={id + '-merge'}>{t('client-config.merge-models')}</Label>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id={id + '-activate'}
              checked={activate && allowActivation}
              disabled={!allowActivation}
              onCheckedChange={(value) => edit(() => setActivate(value === true))}
            />
            <Label htmlFor={id + '-activate'}>{t('client-config.activate')}</Label>
          </div>
          {activate && allowActivation ? (
            <div className="space-y-1">
              <Label htmlFor={id + '-default'}>{t('client-config.default-model')}</Label>
              <Input
                id={id + '-default'}
                value={activateModel}
                onChange={(event) => edit(() => setActivateModel(event.target.value))}
              />
              <p className="text-muted-foreground text-xs">{t('client-config.default-help')}</p>
            </div>
          ) : null}
        </fieldset>
        <p className="text-muted-foreground text-xs">{t('client-config.backend-key')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || management?.nativeSetupBlocked}
            onClick={() => void preview('sync')}
          >
            {t('client-config.preview-save')}
          </Button>
        </div>
      </details>
      {review ? (
        <div className="space-y-2 border-t pt-3">
          <p className="font-medium">
            {t(
              review.plan.action === 'sync'
                ? 'client-config.review-save'
                : 'client-config.review-remove',
            )}
          </p>
          <p className="text-muted-foreground text-xs break-all">{review.result.configPath}</p>
          <p className="text-sm break-all">{review.result.baseUrl}</p>
          <p className="text-xs break-all">{review.result.models.join(', ')}</p>
          {review.result.modelsModeChanged ? (
            <p className="text-sm">{t('client-config.merge-models-change')}</p>
          ) : null}
          {review.result.activateModel ? (
            <p>
              {t('client-config.default-model')}: {review.result.activateModel}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t('client-config.review-help')}</p>
          <div className="flex gap-2">
            <Button
              variant={review.plan.action === 'remove' ? 'destructive' : 'default'}
              disabled={busy || !review.result.changed}
              onClick={() => void apply({ kind: 'reviewed', ...review })}
            >
              {t('client-config.confirm')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>
              {t('client-config.cancel')}
            </Button>
          </div>
          {!review.result.changed ? (
            <p className="text-muted-foreground text-xs">{t('client-config.no-change')}</p>
          ) : null}
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('agent-tools.loading')}
        </p>
      ) : null}
    </NativeClientSetupCard>
  );
}
