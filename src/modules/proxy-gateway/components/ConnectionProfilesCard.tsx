import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ConnectionProfileSaveInputSchema,
  type ConnectionProfileSaveInput,
  type ConnectionProfileView,
} from '../connection-profiles/connection-profiles.schema';
import { readClientConfigFailure } from './client-config-failure';
import { ConnectionProfileOptions } from './ConnectionProfileOptions';
import { gatewayToolNames, gatewayToolOptions } from './gateway-tool-defaults';
import { isImageProxyExampleModel, type ProxyExampleModel } from './proxy-example-models';

export function useConnectionProfiles() {
  return useQuery({
    queryKey: ['gateway', 'connectionProfiles'],
    queryFn: () => ipc.client.gateway.connectionProfiles.list({}),
    retry: false,
  });
}

function initial(
  baseUrl: string,
  client: ConnectionProfileView['client'],
): ConnectionProfileSaveInput {
  return {
    name: '',
    baseUrl,
    ...gatewayToolOptions(client),
    models: [],
    activateModel: null,
    credentialSource: 'manager-default',
  };
}
type Notice =
  | 'invalid-client'
  | 'profile-deleted'
  | 'connection-removed'
  | 'saved-client'
  | ReturnType<typeof readClientConfigFailure>;
type Review = Awaited<ReturnType<typeof ipc.client.gateway.connectionProfiles.preview>>;

export function ConnectionProfilesCard({
  baseUrl,
  models = [],
  client,
  nativeConfigured = false,
  onBusyChange,
}: {
  baseUrl: string;
  models?: readonly ProxyExampleModel[];
  client: ConnectionProfileView['client'];
  nativeConfigured?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<ConnectionProfileSaveInput>(() => initial(baseUrl, client));
  const [modelText, setModelText] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [deleteReview, setDeleteReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const pending = useRef(false);
  const profiles = useConnectionProfiles();
  const toolProfiles = profiles.data?.filter((profile) => profile.client === client) ?? [];
  const selected = toolProfiles.find((profile) => profile.id === draft.id);
  const availableModels = models.filter((model) => !isImageProxyExampleModel(model.id));
  const clientName = gatewayToolNames[client];
  function edit(patch: Partial<ConnectionProfileSaveInput>) {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
    setReview(null);
    setDeleteReview(false);
    setNotice(null);
  }
  function select(profile?: ConnectionProfileView) {
    setDraft(
      profile
        ? {
            id: profile.id,
            expectedRevision: profile.revision,
            name: profile.name,
            client: profile.client,
            baseUrl: profile.baseUrl,
            protocol: profile.protocol,
            sdk: profile.sdk,
            models: profile.models,
            activateModel: profile.activateModel,
            version: profile.version,
            discoverModels: profile.discoverModels,
            dshProfile: profile.dshProfile,
            credentialSource: 'keep',
          }
        : initial(baseUrl, client),
    );
    setModelText(profile?.models.join('\n') ?? '');
    setDirty(false);
    setReview(null);
    setDeleteReview(false);
    setNotice(null);
  }
  function openEditor(profile?: ConnectionProfileView) {
    select(profile);
    setEditorOpen(true);
  }
  async function run(work: () => Promise<void>) {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice(readClientConfigFailure(error));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function saveAndPreview() {
    if (nativeConfigured) {
      return;
    }
    const activateModel = draft.activateModel?.trim() || null;
    const explicitModels = modelText
      .split(/[\n,]/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const modelIds =
      explicitModels.length || activateModel
        ? [...explicitModels, ...(activateModel ? [activateModel] : [])]
        : availableModels.map((model) => model.id);
    const parsed = ConnectionProfileSaveInputSchema.safeParse({
      ...draft,
      name: draft.name.trim() || clientName,
      models: [...new Set(modelIds)],
      activateModel,
    });
    if (!parsed.success) {
      setNotice('invalid-client');
      return;
    }
    void run(async () => {
      const saved = await ipc.client.gateway.connectionProfiles.save(parsed.data);
      select(saved);
      await profiles.refetch();
      setReview(
        await ipc.client.gateway.connectionProfiles.preview({ id: saved.id, action: 'apply' }),
      );
    });
  }
  function preview(action: 'apply' | 'remove') {
    const profileId = draft.id;
    if (!profileId || dirty || (nativeConfigured && action === 'apply')) {
      return;
    }
    setReview(null);
    setDeleteReview(false);
    void run(async () => {
      setReview(await ipc.client.gateway.connectionProfiles.preview({ id: profileId, action }));
    });
  }
  function apply() {
    const captured = review;
    if (!captured || (nativeConfigured && captured.action === 'apply')) {
      return;
    }
    setReview(null);
    void run(async () => {
      await ipc.client.gateway.connectionProfiles.mutate({
        id: captured.id,
        action: captured.action,
        expectedSourceHash: captured.sourceHash,
      });
      setNotice(captured.action === 'remove' ? 'connection-removed' : 'saved-client');
      await profiles.refetch();
    });
  }
  function removeSaved() {
    const captured = selected;
    if (!captured || !deleteReview) {
      return;
    }
    setDeleteReview(false);
    void run(async () => {
      await ipc.client.gateway.connectionProfiles.delete({
        id: captured.id,
        expectedRevision: captured.revision,
      });
      select();
      setEditorOpen(false);
      setNotice('profile-deleted');
      await profiles.refetch();
    });
  }
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b p-4">
        <CardTitle>{t('client-config.connections-title')}</CardTitle>
        <Button
          type="button"
          disabled={busy || profiles.isPending || profiles.isError || nativeConfigured}
          onClick={() => openEditor()}
        >
          {t('client-config.add-connection')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {profiles.isPending ? <p role="status">{t('agent-tools.loading')}</p> : null}
        {profiles.isError ? (
          <div className="space-y-2">
            <p role="alert">{t('client-config.read-failed')}</p>
            <Button variant="outline" disabled={busy} onClick={() => void profiles.refetch()}>
              {t('agent-tools.retry')}
            </Button>
          </div>
        ) : null}
        {nativeConfigured ? (
          <p className="text-muted-foreground text-sm">
            {t('client-config.remove-before-profile')}
          </p>
        ) : null}
        {!toolProfiles.length && profiles.isSuccess && !editorOpen && !nativeConfigured ? (
          <p className="text-muted-foreground text-sm">{t('client-config.connections-empty')}</p>
        ) : null}
        {!!toolProfiles.length && (
          <ul className="divide-border divide-y">
            {toolProfiles.map((profile) => (
              <li
                key={profile.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{profile.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      !profile.credentialConfigured
                        ? 'client-config.config-key-missing'
                        : profile.applied
                          ? 'client-config.connection-unverified'
                          : 'client-config.connection-saved',
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => openEditor(profile)}
                  aria-label={t('client-config.connection-details-name', { name: profile.name })}
                >
                  {t('client-config.connection-details')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {editorOpen && (
          <fieldset
            disabled={busy || profiles.isPending || profiles.isError}
            className="space-y-4 border-t pt-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {selected?.name ?? t('client-config.add-connection')}
              </h3>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  select();
                  setEditorOpen(false);
                }}
              >
                {t('common.close')}
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={id + '-default'}>{t('client-config.default-model')}</Label>
                <Input
                  id={id + '-default'}
                  list={id + '-available-models'}
                  value={draft.activateModel ?? ''}
                  onChange={(event) => edit({ activateModel: event.target.value || null })}
                />
                <datalist id={id + '-available-models'}>
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>
                <p className="text-muted-foreground text-xs">
                  {t(
                    draft.client === 'claude' || draft.client === 'codex'
                      ? 'client-config.profile-required-default'
                      : 'client-config.optional-default',
                  )}
                </p>
              </div>
            </div>
            <ConnectionProfileOptions
              key={draft.id ?? 'new'}
              id={id}
              draft={draft}
              modelText={modelText}
              clientName={clientName}
              edit={edit}
              setModelText={setModelText}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  nativeConfigured || Boolean(draft.id && !dirty && !selected?.credentialConfigured)
                }
                onClick={!draft.id || dirty ? saveAndPreview : () => preview('apply')}
              >
                {t(
                  !draft.id || dirty
                    ? 'client-config.save-and-preview'
                    : 'client-config.preview-save',
                )}
              </Button>
              {selected?.applied && (
                <Button variant="outline" disabled={dirty} onClick={() => preview('remove')}>
                  {t('client-config.preview-remove')}
                </Button>
              )}
              {selected && !selected.applied && (
                <Button
                  variant="outline"
                  disabled={dirty}
                  onClick={() => {
                    setReview(null);
                    setDeleteReview(true);
                  }}
                >
                  {t('client-config.profile-delete')}
                </Button>
              )}
            </div>
            {selected?.applied && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm">
                  {t('client-config.verify-in-traffic')}
                </p>
                <Button variant="outline" asChild>
                  <Link to="/traffic" search={{ page: 0, search: '', tab: 'model' }}>
                    {t('client-config.open-traffic')}
                  </Link>
                </Button>
              </div>
            )}
          </fieldset>
        )}
        {review ? (
          <section className="space-y-2 border-t pt-3">
            <p className="font-medium">
              {t(
                review.action === 'apply'
                  ? 'client-config.review-save'
                  : 'client-config.review-remove',
              )}
            </p>
            <p>
              {t(
                review.nativeMode === 'provider'
                  ? 'client-config.profile-provider-mode'
                  : 'client-config.profile-single-active',
              )}
            </p>
            <p className="text-xs break-all">{review.configPath}</p>
            {review.additionalConfigPath ? (
              <p className="text-xs break-all">{review.additionalConfigPath}</p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('client-config.review-help')}</p>
            <Button
              disabled={busy || !review.changed || (nativeConfigured && review.action === 'apply')}
              variant={review.action === 'remove' ? 'destructive' : 'default'}
              onClick={apply}
            >
              {t('client-config.confirm')}
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => setReview(null)}>
              {t('common.cancel')}
            </Button>
            {!review.changed ? <p>{t('client-config.no-change')}</p> : null}
          </section>
        ) : null}
        {deleteReview && selected ? (
          <section className="space-y-2 border-t pt-3">
            <p>{t('client-config.profile-delete-help', { name: selected.name })}</p>
            <Button disabled={busy} variant="destructive" onClick={removeSaved}>
              {t('client-config.confirm')}
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => setDeleteReview(false)}>
              {t('common.cancel')}
            </Button>
          </section>
        ) : null}
        {busy ? <p role="status">{t('agent-tools.loading')}</p> : null}
        {notice ? (
          <p
            role={
              ['connection-removed', 'profile-deleted', 'saved-client'].includes(notice)
                ? 'status'
                : 'alert'
            }
            className="text-sm"
          >
            {t('client-config.' + notice, {
              name: notice === 'saved-client' ? clientName : draft.name,
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
