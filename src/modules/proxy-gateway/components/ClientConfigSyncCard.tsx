import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readClientConfigFailure } from './client-config-failure';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ClientConfigPreviewInputSchema, type ClientConfigPlan } from '../agent-tools/client-config.schema';

type Client = 'hermes' | 'openclaw';
type Review = { plan: ClientConfigPlan; result: Awaited<ReturnType<typeof ipc.client.gateway.clientConfig.preview>> };

export function ClientConfigSyncCard({ client, baseUrl }: { client: Client; baseUrl: string }) {
  const { t } = useTranslation();
  const id = useId();
  const name = client === 'hermes' ? 'Hermes' : 'OpenClaw';
  const [address, setAddress] = useState(baseUrl);
  const [models, setModels] = useState('');
  const [activate, setActivate] = useState(false);
  const [activateModel, setActivateModel] = useState('');
  const [discoverModels, setDiscoverModels] = useState(true);
  const [version, setVersion] = useState('');
  const [mergeModels, setMergeModels] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved-client' | 'invalid-client' | ReturnType<typeof readClientConfigFailure> | null>(null);
  const pending = useRef(false);
  const status = useQuery({
    queryKey: ['gateway', 'clientConfig', client],
    queryFn: () => ipc.client.gateway.clientConfig.status({ client }),
    retry: false,
  });
  const edit = (change: () => void) => {
    change();
    setReview(null);
    setNotice(null);
  };
  const preview = async (action: 'sync' | 'remove') => {
    if (pending.current) {
      return;
    }
    const modelIds = [...new Set(models.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean))];
    const parsed = ClientConfigPreviewInputSchema.safeParse(action === 'remove' ? { client, action } : {
      client, action, baseUrl: address, models: modelIds, activateModel: activate ? activateModel : null,
      ...(client === 'hermes' ? { discoverModels } : { version, modelsMode: mergeModels ? 'merge' : 'preserve' }),
    });
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
  const apply = async () => {
    if (pending.current || !review) {
      return;
    }
    const current = review;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setReview(null);
    try {
      await ipc.client.gateway.clientConfig.mutate({ plan: current.plan, expectedSourceHash: current.result.sourceHash });
      setNotice('saved-client');
      void status.refetch();
    } catch (error) {
      setNotice(readClientConfigFailure(error));
      void status.refetch();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Card className="shadow-none">
    <CardHeader className="border-b p-4">
      <CardTitle>{name}</CardTitle>
      <p className="text-muted-foreground text-sm">{t('client-config.client-description', { name })}</p>
    </CardHeader>
    <CardContent className="space-y-4 p-4">
      <div aria-live="polite" className="text-muted-foreground space-y-1 text-xs">
        {status.isFetching ? <p>{t('agent-tools.loading')}</p> : null}
        {status.data && !status.isError ? <>
          <p>{status.data.installed ? status.data.version ?? t('client-config.version-unknown') : t('agent-tools.not-installed')}</p>
          <p className="break-all">{status.data.configPath}</p>
          <p>{t(status.data.exists ? 'client-config.profile-found' : 'client-config.profile-missing')}</p>
        </> : null}
        {status.isError ? <p role="alert">{t('client-config.client-read-failed')}</p> : null}
      </div>
      <fieldset disabled={busy} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor={id + '-address'}>{t('agent-tools.address')}</Label>
          <Input id={id + '-address'} value={address} onChange={(event) => edit(() => setAddress(event.target.value))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id + '-models'}>{t('client-config.model-ids')}</Label>
          <Textarea id={id + '-models'} value={models} onChange={(event) => edit(() => setModels(event.target.value))} />
        </div>
        {client === 'hermes' ? <div className="flex items-center gap-2">
          <Checkbox id={id + '-discover'} checked={discoverModels} onCheckedChange={(value) => edit(() => setDiscoverModels(value === true))} />
          <Label htmlFor={id + '-discover'}>{t('client-config.discover-models')}</Label>
        </div> : <div className="space-y-1">
          <Label htmlFor={id + '-version'}>{t('client-config.openclaw-version')}</Label>
          <Select value={version} onValueChange={(value) => edit(() => setVersion(value))}>
            <SelectTrigger id={id + '-version'}><SelectValue placeholder={t('client-config.choose-version')} /></SelectTrigger>
            <SelectContent><SelectItem value="v1">v1</SelectItem><SelectItem value="v2">v2</SelectItem></SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('client-config.version-help')}</p>
          <div className="flex items-center gap-2">
            <Checkbox id={id + '-merge'} checked={mergeModels} onCheckedChange={(value) => edit(() => setMergeModels(value === true))} />
            <Label htmlFor={id + '-merge'}>{t('client-config.merge-models')}</Label>
          </div>
        </div>}
        <div className="flex items-center gap-2">
          <Checkbox id={id + '-activate'} checked={activate} onCheckedChange={(value) => edit(() => setActivate(value === true))} />
          <Label htmlFor={id + '-activate'}>{t('client-config.activate')}</Label>
        </div>
        {activate ? <div className="space-y-1">
          <Label htmlFor={id + '-default'}>{t('client-config.default-model')}</Label>
          <Input id={id + '-default'} value={activateModel} onChange={(event) => edit(() => setActivateModel(event.target.value))} />
          <p className="text-muted-foreground text-xs">{t('client-config.default-help')}</p>
        </div> : null}
      </fieldset>
      <p className="text-muted-foreground text-xs">{t('client-config.backend-key')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void preview('sync')}>{t('client-config.preview-save')}</Button>
        <Button variant="outline" disabled={busy || !status.data?.exists} onClick={() => void preview('remove')}>{t('client-config.preview-remove')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void status.refetch()}>{t('agent-tools.retry')}</Button>
      </div>
      {review ? <div className="space-y-2 border-t pt-3">
        <p className="font-medium">{t(review.plan.action === 'sync' ? 'client-config.review-save' : 'client-config.review-remove')}</p>
        <p className="text-muted-foreground break-all text-xs">{review.result.configPath}</p>
        <p className="break-all text-sm">{review.result.baseUrl}</p>
        <p className="break-all text-xs">{review.result.models.join(', ')}</p>
        {review.result.modelsModeChanged ? <p className="text-sm">{t('client-config.merge-models-change')}</p> : null}
        {review.result.activateModel ? <p>{t('client-config.default-model')}: {review.result.activateModel}</p> : null}
        <p className="text-muted-foreground text-xs">{t('client-config.review-help')}</p>
        <div className="flex gap-2">
          <Button variant={review.plan.action === 'remove' ? 'destructive' : 'default'} disabled={busy || !review.result.changed} onClick={() => void apply()}>{t('client-config.confirm')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>{t('client-config.cancel')}</Button>
        </div>
        {!review.result.changed ? <p className="text-muted-foreground text-xs">{t('client-config.no-change')}</p> : null}
      </div> : null}
      {busy ? <p role="status" className="text-muted-foreground text-sm">{t('agent-tools.loading')}</p> : null}
      {notice ? <p role={notice === 'saved-client' ? 'status' : 'alert'} className={notice === 'saved-client' ? 'text-success text-sm' : 'text-destructive text-sm'}>{t('client-config.' + notice, { name })}</p> : null}
    </CardContent>
  </Card>;
}
