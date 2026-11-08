import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConnectionProfileSaveInputSchema, type ConnectionProfileSaveInput, type ConnectionProfileView } from '../connection-profiles/connection-profiles.schema';
import { readClientConfigFailure } from './client-config-failure';

const clients = ['claude', 'codex', 'opencode', 'hermes', 'openclaw', 'dsh'] as const;
function initial(baseUrl: string): ConnectionProfileSaveInput {
  return { name: '', client: 'claude', baseUrl, protocol: 'anthropic-messages', sdk: null,
    models: [], activateModel: null, version: null, discoverModels: false, dshProfile: null, credentialSource: 'manager-default' };
}
type Notice = 'invalid-client' | 'profile-saved' | 'profile-deleted' | 'saved-client' | ReturnType<typeof readClientConfigFailure>;
type Review = Awaited<ReturnType<typeof ipc.client.gateway.connectionProfiles.preview>>;

export function ConnectionProfilesCard({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<ConnectionProfileSaveInput>(() => initial(baseUrl));
  const [modelText, setModelText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [deleteReview, setDeleteReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const pending = useRef(false);
  const profiles = useQuery({ queryKey: ['gateway', 'connectionProfiles'], queryFn: () => ipc.client.gateway.connectionProfiles.list({}), retry: false });
  const selected = profiles.data?.find((profile) => profile.id === draft.id);
  function edit(patch: Partial<ConnectionProfileSaveInput>) {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
    setReview(null);
    setDeleteReview(false);
    setNotice(null);
  }
  function select(profile?: ConnectionProfileView) {
    setDraft(profile ? {
      id: profile.id, expectedRevision: profile.revision, name: profile.name, client: profile.client,
      baseUrl: profile.baseUrl, protocol: profile.protocol, sdk: profile.sdk, models: profile.models,
      activateModel: profile.activateModel, version: profile.version, discoverModels: profile.discoverModels,
      dshProfile: profile.dshProfile, credentialSource: 'keep',
    } : initial(baseUrl));
    setModelText(profile?.models.join('\n') ?? '');
    setDirty(false);
    setReview(null);
    setDeleteReview(false);
    setNotice(null);
  }
  async function run(work: () => Promise<void>) {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try { await work(); } catch (error) { setNotice(readClientConfigFailure(error)); }
    finally { pending.current = false; setBusy(false); }
  }
  function save() {
    const parsed = ConnectionProfileSaveInputSchema.safeParse({ ...draft,
      models: [...new Set(modelText.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean))],
      activateModel: draft.activateModel?.trim() || null,
    });
    if (!parsed.success) {
      setNotice('invalid-client');
      return;
    }
    void run(async () => {
      const saved = await ipc.client.gateway.connectionProfiles.save(parsed.data);
      select(saved);
      setNotice('profile-saved');
      await profiles.refetch();
    });
  }
  function preview(action: 'apply' | 'remove') {
    const profileId = draft.id;
    if (!profileId || dirty) {
      return;
    }
    setReview(null);
    setDeleteReview(false);
    void run(async () => { setReview(await ipc.client.gateway.connectionProfiles.preview({ id: profileId, action })); });
  }
  function apply() {
    const captured = review;
    if (!captured) {
      return;
    }
    setReview(null);
    void run(async () => {
      await ipc.client.gateway.connectionProfiles.mutate({ id: captured.id, action: captured.action, expectedSourceHash: captured.sourceHash });
      setNotice('saved-client');
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
      await ipc.client.gateway.connectionProfiles.delete({ id: captured.id, expectedRevision: captured.revision });
      select();
      setNotice('profile-deleted');
      await profiles.refetch();
    });
  }
  function changeClient(value: string) {
    const client = clients.find((item) => item === value);
    if (!client) {
      return;
    }
    edit({ client, protocol: client === 'claude' ? 'anthropic-messages' : client === 'codex' ? 'openai-responses' : 'openai-completions',
      sdk: client === 'opencode' ? '@ai-sdk/openai-compatible' : null, version: client === 'openclaw' ? 'v2' : null,
      discoverModels: client === 'hermes', dshProfile: client === 'dsh' ? 'web' : null });
  }
  function changeProtocol(protocol: ConnectionProfileSaveInput['protocol']) {
    edit({ protocol, sdk: draft.client !== 'opencode' ? null : protocol === 'anthropic-messages' ? '@ai-sdk/anthropic'
      : protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible' });
  }
  return <Card className="shadow-none">
    <CardHeader className="border-b p-4"><CardTitle>{t('client-config.profiles-title')}</CardTitle>
      <p className="text-muted-foreground text-sm">{t('client-config.profiles-help')}</p></CardHeader>
    <CardContent className="space-y-4 p-4">
      {profiles.isPending ? <p role="status">{t('agent-tools.loading')}</p> : null}
      {profiles.isError ? <p role="alert">{t('client-config.read-failed')}</p> : null}
      <fieldset disabled={busy || profiles.isPending || profiles.isError} className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1"><Label htmlFor={id + '-select'}>{t('client-config.profiles-title')}</Label>
            <Select value={draft.id ?? 'new'} onValueChange={(value) => select(profiles.data?.find((profile) => profile.id === value))}>
              <SelectTrigger id={id + '-select'}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="new">{t('client-config.profile-new')}</SelectItem>
                {profiles.data?.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.client}</SelectItem>)}
              </SelectContent></Select></div>
          <Button variant="outline" onClick={() => select()}>{t('client-config.profile-new')}</Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1"><Label htmlFor={id + '-name'}>{t('client-config.profile-name')}</Label><Input id={id + '-name'} value={draft.name} onChange={(event) => edit({ name: event.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={id + '-client'}>{t('client-config.profile-client')}</Label>
            <Select value={draft.client} onValueChange={changeClient}><SelectTrigger id={id + '-client'}><SelectValue /></SelectTrigger>
              <SelectContent>{clients.map((client) => <SelectItem key={client} value={client}>{client}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor={id + '-url'}>{t('agent-tools.address')}</Label><Input id={id + '-url'} value={draft.baseUrl} onChange={(event) => edit({ baseUrl: event.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={id + '-credential'}>{t('client-config.profile-credential')}</Label>
            <Select value={draft.credentialSource} onValueChange={(value) => { const source = ConnectionProfileSaveInputSchema.shape.credentialSource.safeParse(value); if (source.success) { edit({ credentialSource: source.data }); } }}>
              <SelectTrigger id={id + '-credential'}><SelectValue /></SelectTrigger><SelectContent>
                {draft.id ? <SelectItem value="keep">{t('client-config.profile-key-keep')}</SelectItem> : null}
                <SelectItem value="manager-default">{t('client-config.profile-key-manager')}</SelectItem>
                <SelectItem value="opencode-dedicated">{t('client-config.profile-key-opencode')}</SelectItem>
                <SelectItem value="client-configured">{t('client-config.profile-key-client')}</SelectItem>
              </SelectContent></Select></div>
        </div>
        {(draft.client === 'opencode' || draft.client === 'dsh') ? <div className="space-y-1"><Label htmlFor={id + '-protocol'}>{t('client-config.protocol')}</Label>
          <Select value={draft.protocol} onValueChange={(value) => { if (value === 'anthropic-messages' || value === 'openai-completions' || value === 'openai-responses') { changeProtocol(value); } }}>
            <SelectTrigger id={id + '-protocol'}><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem><SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem><SelectItem value="openai-responses">OpenAI Responses</SelectItem>
            </SelectContent></Select>{draft.sdk ? <p className="text-muted-foreground text-xs">{draft.sdk}</p> : null}</div> : null}
        {draft.client === 'dsh' ? <div className="space-y-1"><Label htmlFor={id + '-dsh'}>{t('client-config.profile')}</Label><Input id={id + '-dsh'} value={draft.dshProfile ?? ''} onChange={(event) => edit({ dshProfile: event.target.value })} /></div> : null}
        {draft.client === 'openclaw' ? <div className="space-y-1"><Label htmlFor={id + '-version'}>{t('client-config.openclaw-version')}</Label><Select value={draft.version ?? ''} onValueChange={(value) => { if (value === 'v1' || value === 'v2') { edit({ version: value }); } }}><SelectTrigger id={id + '-version'}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="v1">v1</SelectItem><SelectItem value="v2">v2</SelectItem></SelectContent></Select><p className="text-muted-foreground text-xs">{t('client-config.version-help')}</p></div> : null}
        {draft.client === 'hermes' ? <div className="flex items-center gap-2"><Checkbox id={id + '-discover'} checked={draft.discoverModels} onCheckedChange={(checked) => edit({ discoverModels: checked === true })} /><Label htmlFor={id + '-discover'}>{t('client-config.discover-models')}</Label></div> : null}
        <div className="space-y-1"><Label htmlFor={id + '-models'}>{t('client-config.model-ids')}</Label><Textarea id={id + '-models'} value={modelText} onChange={(event) => { setModelText(event.target.value); edit({}); }} /></div>
        <div className="space-y-1"><Label htmlFor={id + '-default'}>{t('client-config.default-model')}</Label><Input id={id + '-default'} value={draft.activateModel ?? ''} onChange={(event) => edit({ activateModel: event.target.value || null })} /><p className="text-muted-foreground text-xs">{t(draft.client === 'claude' || draft.client === 'codex' ? 'client-config.profile-required-default' : 'client-config.default-help')}</p></div>
        <p className="text-muted-foreground text-xs">{t('client-config.backend-key')}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save}>{t('client-config.profile-save')}</Button>
          <Button variant="outline" disabled={!draft.id || dirty || !selected?.credentialConfigured} onClick={() => preview('apply')}>{t('client-config.preview-save')}</Button>
          <Button variant="outline" disabled={!draft.id || dirty || !selected?.applied} onClick={() => preview('remove')}>{t('client-config.preview-remove')}</Button>
          <Button variant="outline" disabled={!selected || dirty || selected.applied} onClick={() => { setReview(null); setDeleteReview(true); }}>{t('client-config.profile-delete')}</Button>
        </div>
      </fieldset>
      <Button variant="ghost" disabled={busy} onClick={() => void profiles.refetch()}>{t('agent-tools.retry')}</Button>
      {review ? <section className="space-y-2 border-t pt-3">
        <p className="font-medium">{t(review.action === 'apply' ? 'client-config.review-save' : 'client-config.review-remove')}</p>
        <p>{t(review.nativeMode === 'provider' ? 'client-config.profile-provider-mode' : 'client-config.profile-single-active')}</p>
        <p className="break-all text-xs">{review.configPath}</p>
        <p className="text-muted-foreground text-xs">{t('client-config.review-help')}</p>
        <Button disabled={busy || !review.changed} variant={review.action === 'remove' ? 'destructive' : 'default'} onClick={apply}>{t('client-config.confirm')}</Button>
        <Button disabled={busy} variant="outline" onClick={() => setReview(null)}>{t('common.cancel')}</Button>
        {!review.changed ? <p>{t('client-config.no-change')}</p> : null}
      </section> : null}
      {deleteReview && selected ? <section className="space-y-2 border-t pt-3"><p>{t('client-config.profile-delete-help', { name: selected.name })}</p><Button disabled={busy} variant="destructive" onClick={removeSaved}>{t('client-config.confirm')}</Button><Button disabled={busy} variant="outline" onClick={() => setDeleteReview(false)}>{t('common.cancel')}</Button></section> : null}
      {busy ? <p role="status">{t('agent-tools.loading')}</p> : null}
      {notice ? <p role={['profile-saved', 'profile-deleted', 'saved-client'].includes(notice) ? 'status' : 'alert'} className="text-sm">{t('client-config.' + notice, { name: notice === 'saved-client' ? draft.client : draft.name })}</p> : null}
    </CardContent>
  </Card>;
}
