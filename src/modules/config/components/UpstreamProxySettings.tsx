import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import {
  readServiceConfigErrorCode,
  type ServiceConfigSnapshot,
  type ServiceConfigUpdate,
  type ServiceSecretWrite,
} from '../service-config.schema';
import { UpstreamProxyUrlSchema } from '../upstream-proxy.schema';

interface UpstreamProxySettingsProps {
  proxy: Pick<ServiceConfigSnapshot['proxy'], 'upstream_proxy' | 'upstream_proxy_configured'>;
  available: boolean;
  onSaved(): Promise<void>;
}

export function UpstreamProxySettings({ proxy, available, onSaved }: UpstreamProxySettingsProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidDraft =
    draft !== null && draft.trim() !== '' && !UpstreamProxyUrlSchema.safeParse(draft).success;
  const invalidConfig = proxy.upstream_proxy.enabled && !proxy.upstream_proxy_configured;

  const reportFailure = (error: unknown) => {
    toast({
      title: t(
        readServiceConfigErrorCode(error) === 'invalid-input'
          ? 'settings.proxy.configuration-invalid'
          : 'settings.service-unavailable',
      ),
      variant: 'destructive',
    });
  };

  const save = async (change: ServiceConfigUpdate | ServiceSecretWrite) => {
    setBusy(true);
    try {
      const result =
        'name' in change
          ? await ipc.client.config.service.writeSecret(change)
          : await ipc.client.config.service.update(change);
      if ('name' in change) {
        setDraft(null);
      }
      await onSaved();
      toast({
        title:
          result.state === 'applied'
            ? t('settings.toast.saved.title')
            : t('settings.service-restart-required'),
      });
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    setBusy(true);
    try {
      const result = await ipc.client.config.service.revealSecret({ name: 'upstream-proxy' });
      setDraft(result.value);
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-none">
      <CardHeader className="p-4">
        <CardTitle>{t('settings.proxy.title')}</CardTitle>
        <CardDescription>{t('settings.proxy.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="flex items-center justify-between space-x-2">
          <Label htmlFor="upstream-proxy-enabled">{t('settings.proxy.enable')}</Label>
          <Switch
            id="upstream-proxy-enabled"
            checked={proxy.upstream_proxy.enabled}
            disabled={
              !available ||
              busy ||
              (!proxy.upstream_proxy.enabled && !proxy.upstream_proxy_configured)
            }
            aria-describedby="upstream-proxy-help"
            onCheckedChange={(enabled) => void save({ proxy: { upstream_proxy: { enabled } } })}
          />
        </div>
        <p
          id="upstream-proxy-help"
          className={invalidConfig ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
          role={invalidConfig ? 'alert' : undefined}
        >
          {t(
            invalidConfig
              ? 'settings.proxy.configuration-invalid'
              : 'settings.proxy.configure-before-enabling',
          )}
        </p>
        <div className="space-y-2">
          <Label htmlFor="upstream-proxy-url">{t('settings.proxy.url')}</Label>
          <Input
            id="upstream-proxy-url"
            placeholder={
              proxy.upstream_proxy_configured
                ? t('settings.service-secret-configured')
                : 'http://127.0.0.1:7890'
            }
            type="password"
            value={draft ?? ''}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!available || busy}
            aria-invalid={invalidDraft}
            aria-describedby={invalidDraft ? 'upstream-proxy-url-error' : 'upstream-proxy-help'}
          />
          {invalidDraft && (
            <p id="upstream-proxy-url-error" role="alert" className="text-destructive text-sm">
              {t('settings.proxy.url-invalid')}
            </p>
          )}
          <Button disabled={!available || busy} onClick={() => void reveal()}>
            {t('proxy.config.show_key')}
          </Button>
          <Button
            disabled={!available || busy || draft === null || invalidDraft}
            onClick={() => void save({ name: 'upstream-proxy', value: draft?.trim() || null })}
          >
            {t('settings.service-save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
