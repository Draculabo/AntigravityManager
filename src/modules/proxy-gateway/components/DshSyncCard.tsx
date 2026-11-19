import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { readClientConfigFailure } from './client-config-failure';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { NativeClientSetupCard, type ToolManagement } from './NativeClientSetupCard';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DshPreviewInputSchema,
  DshProfileInputSchema,
  type DshPreviewInput,
} from '../dsh-sync/dsh-owner.schema';

type Preview = Awaited<ReturnType<typeof ipc.client.gateway.dsh.preview>>;
type ReviewedPlan = { input: DshPreviewInput; result: Preview };
type SetupAction =
  | { kind: 'quick'; input: DshPreviewInput }
  | ({ kind: 'reviewed' } & ReviewedPlan);

export function DshSyncCard({
  baseUrl,
  quickModels = [],
  management,
}: {
  baseUrl: string;
  quickModels?: readonly string[];
  management?: ToolManagement;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [profile, setProfile] = useState('web');
  const [protocol, setProtocol] = useState('openai-completions');
  const [address, setAddress] = useState(baseUrl);
  const [credentialRef, setCredentialRef] = useState('');
  const [models, setModels] = useState('');
  const [storeKey, setStoreKey] = useState(false);
  const [activate, setActivate] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const [reviewed, setReviewed] = useState<ReviewedPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    | 'saved-client'
    | 'connection-removed'
    | 'invalid'
    | ReturnType<typeof readClientConfigFailure>
    | null
  >(null);
  const quickModel = quickModels[0];
  const allowActivation = !management?.blocksNativeActivation?.(profile);
  const running = useRef(false);
  const validProfile = DshProfileInputSchema.safeParse({ profile }).success;
  const readProfile = async (name: string) => {
    const status = await ipc.client.gateway.dsh.status({ profile: name });
    try {
      const removal = status.exists
        ? await ipc.client.gateway.dsh.preview({ profile: name, action: 'remove' })
        : undefined;
      return { ...status, managed: Boolean(removal?.baseUrl), ownershipError: null };
    } catch (error) {
      return { ...status, managed: false, ownershipError: readClientConfigFailure(error) };
    }
  };
  const status = useQuery({
    queryKey: ['gateway', 'dsh', profile],
    queryFn: () => readProfile(profile),
    enabled: validProfile,
    retry: false,
  });
  const quickStatus = useQuery({
    queryKey: ['gateway', 'dsh', 'web'],
    queryFn: () => readProfile('web'),
    retry: false,
  });
  const edit = (change: () => void) => {
    change();
    setReviewed(null);
    setNotice(null);
  };
  const preview = async (action: 'sync' | 'remove') => {
    if (running.current) {
      return;
    }
    const parsed = DshPreviewInputSchema.safeParse(
      action === 'remove'
        ? { profile, action }
        : {
            profile,
            action,
            protocol,
            baseUrl: address,
            credentialRef: storeKey ? 'ANTIGRAVITY_MANAGER' : credentialRef,
            credentialMode: storeKey ? 'manager-key' : 'existing-reference',
            activateModel: activate && allowActivation ? defaultModel.trim() : null,
            models: [
              ...new Set(
                models
                  .split(/[\n,]/u)
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ],
          },
    );
    setReviewed(null);
    if (!parsed.success) {
      setNotice('invalid');
      return;
    }
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await ipc.client.gateway.dsh.preview(parsed.data);
      setReviewed({ input: parsed.data, result });
    } catch (error) {
      setNotice(readClientConfigFailure(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const apply = async (action: SetupAction) => {
    if (
      running.current ||
      (action.input.action === 'sync' &&
        action.input.activateModel &&
        management?.blocksNativeActivation?.(action.input.profile))
    ) {
      return;
    }
    running.current = true;
    setBusy(true);
    setReviewed(null);
    setNotice(null);
    try {
      const result =
        action.kind === 'quick'
          ? await ipc.client.gateway.dsh.preview(action.input)
          : action.result;
      if (action.input.action === 'sync') {
        await ipc.client.gateway.dsh.sync({
          ...action.input,
          expectedSourceHash: result.sourceHash,
        });
      } else {
        await ipc.client.gateway.dsh.remove({
          profile: action.input.profile,
          expectedSourceHash: result.sourceHash,
        });
      }
      setNotice(action.input.action === 'remove' ? 'connection-removed' : 'saved-client');
    } catch (error) {
      setNotice(readClientConfigFailure(error));
    } finally {
      if (action.input.profile === 'web') {
        await quickStatus.refetch();
      } else {
        await status.refetch();
      }
      running.current = false;
      setBusy(false);
    }
  };
  const configure = () => {
    if (!quickModel || !quickStatus.data?.exists) {
      return;
    }
    void apply({
      kind: 'quick',
      input: {
        action: 'sync',
        profile: 'web',
        protocol: 'openai-completions',
        baseUrl,
        credentialRef: 'ANTIGRAVITY_MANAGER',
        credentialMode: 'manager-key',
        activateModel: management?.blocksNativeActivation?.('web') ? null : quickModel,
        models: quickModels.slice(0, 256),
      },
    });
  };
  return (
    <NativeClientSetupCard
      name="DSH"
      defaultModel={quickModel}
      management={management}
      configured={quickStatus.data?.managed}
      status={
        quickStatus.isPending
          ? t('agent-tools.loading')
          : quickStatus.data?.managed
            ? t('client-config.connection-unverified')
            : undefined
      }
      busy={busy}
      ready={
        quickStatus.data?.exists === true &&
        !quickStatus.isError &&
        !quickStatus.data.ownershipError
      }
      onConfigure={configure}
      feedback={
        notice ? (
          <p
            role={notice === 'saved-client' || notice === 'connection-removed' ? 'status' : 'alert'}
            className="text-sm"
          >
            {t('client-config.' + notice, { name: 'DSH' })}
          </p>
        ) : quickStatus.isSuccess && !quickStatus.data.exists ? (
          <p className="text-muted-foreground text-xs">{t('client-config.quick-dsh-missing')}</p>
        ) : quickStatus.data?.ownershipError ? (
          <p role="alert" className="text-sm">
            {t('client-config.' + quickStatus.data.ownershipError)}
          </p>
        ) : quickStatus.isError ? (
          <p role="alert" className="text-sm">
            {t('client-config.read-failed')}
          </p>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !validProfile || !status.data?.exists}
          onClick={() => void preview('remove')}
        >
          {t('agent-tools.remove')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !validProfile}
          onClick={() => void status.refetch()}
        >
          {t('agent-tools.retry')}
        </Button>
      </div>
      <details className="space-y-3">
        <summary className="text-sm font-medium">{t('client-config.edit-settings')}</summary>
        <fieldset disabled={busy} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={id + '-profile'}>{t('client-config.profile')}</Label>
            <Input
              id={id + '-profile'}
              value={profile}
              onChange={(event) => edit(() => setProfile(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id + '-protocol'}>{t('client-config.protocol')}</Label>
            <Select value={protocol} onValueChange={(value) => edit(() => setProtocol(value))}>
              <SelectTrigger id={id + '-protocol'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
                <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
                <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={id + '-address'}>{t('agent-tools.address')}</Label>
            <Input
              id={id + '-address'}
              value={address}
              onChange={(event) => edit(() => setAddress(event.target.value))}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={id + '-store-key'}
                checked={storeKey}
                onCheckedChange={(checked) => edit(() => setStoreKey(checked === true))}
              />
              <Label htmlFor={id + '-store-key'}>{t('client-config.dsh-store-key')}</Label>
            </div>
            <p className="text-muted-foreground text-xs">{t('client-config.dsh-store-key-help')}</p>
            <Label htmlFor={id + '-credential'}>{t('client-config.credential-reference')}</Label>
            <Input
              id={id + '-credential'}
              disabled={storeKey}
              value={credentialRef}
              autoComplete="off"
              aria-describedby={id + '-credential-help'}
              onChange={(event) => edit(() => setCredentialRef(event.target.value))}
            />
            <p id={id + '-credential-help'} className="text-muted-foreground text-xs">
              {t('client-config.credential-reference-help')}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={id + '-models'}>{t('client-config.model-ids')}</Label>
            <Textarea
              id={id + '-models'}
              value={models}
              onChange={(event) => edit(() => setModels(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={id + '-activate'}
                checked={activate && allowActivation}
                disabled={!allowActivation}
                onCheckedChange={(checked) => edit(() => setActivate(checked === true))}
              />
              <Label htmlFor={id + '-activate'}>{t('client-config.activate')}</Label>
            </div>
            {activate && allowActivation ? (
              <>
                <Label htmlFor={id + '-default'}>{t('client-config.default-model')}</Label>
                <Input
                  id={id + '-default'}
                  value={defaultModel}
                  onChange={(event) => edit(() => setDefaultModel(event.target.value))}
                />
              </>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('client-config.default-help')}</p>
          </div>
        </fieldset>
        <div className="text-muted-foreground space-y-1 text-xs" aria-live="polite">
          {status.isFetching ? <p>{t('agent-tools.loading')}</p> : null}
          {status.data && !status.isError ? (
            <>
              <p className="break-all">{status.data.patchPath}</p>
              <p>
                {t(
                  status.data.exists
                    ? 'client-config.profile-found'
                    : 'client-config.profile-missing',
                )}
              </p>
            </>
          ) : null}
          {status.isError ? <p role="alert">{t('client-config.read-failed')}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !validProfile}
            onClick={() => void preview('sync')}
          >
            {t('client-config.preview-save')}
          </Button>
        </div>
      </details>
      {reviewed ? (
        <div className="space-y-2 border-t pt-3">
          <p className="font-medium">
            {t(
              reviewed.input.action === 'sync'
                ? 'client-config.review-save'
                : 'client-config.review-remove',
            )}
          </p>
          <p className="text-muted-foreground text-xs break-all">{reviewed.result.patchPath}</p>
          <p className="text-sm break-all">
            {reviewed.result.providerId} · {reviewed.result.protocol} · {reviewed.result.baseUrl}
          </p>
          {reviewed.result.models.length > 0 ? (
            <p className="text-xs break-all">{reviewed.result.models.join(', ')}</p>
          ) : null}
          {reviewed.result.credentialRef ? (
            <p className="text-xs break-all">
              {t('client-config.credential-reference')}: {reviewed.result.credentialRef}
            </p>
          ) : null}
          {reviewed.result.credentialAction === 'retain' ? (
            <p className="text-muted-foreground text-xs">
              {t('client-config.dsh-credential-retained')}
            </p>
          ) : null}
          {reviewed.result.credentialAction === 'remove' ? (
            <p className="text-muted-foreground text-xs">
              {t('client-config.dsh-credential-remove')}
            </p>
          ) : null}
          {reviewed.result.defaultAction !== 'preserve' ? (
            <p className="text-xs break-all">
              {t(
                reviewed.result.defaultAction === 'restore'
                  ? 'client-config.dsh-default-restore'
                  : 'client-config.default-model',
              )}
              : {reviewed.result.defaultModel}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t('client-config.review-help')}</p>
          <div className="flex gap-2">
            <Button
              variant={reviewed.input.action === 'remove' ? 'destructive' : 'default'}
              disabled={busy || !reviewed.result.changed}
              onClick={() => void apply({ kind: 'reviewed', ...reviewed })}
            >
              {t('client-config.confirm')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setReviewed(null)}>
              {t('client-config.cancel')}
            </Button>
          </div>
          {!reviewed.result.changed ? (
            <p className="text-muted-foreground text-xs">{t('client-config.no-change')}</p>
          ) : null}
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('agent-tools.loading')}
        </p>
      ) : null}
    </NativeClientSetupCard>
  );
}
