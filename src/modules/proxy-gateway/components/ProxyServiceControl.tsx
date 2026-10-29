import { Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ProxyRiskConfirmation, useProxyRiskConfirmation } from './ProxyRiskConfirmation';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];

interface ProxyServiceControlProps {
  config: ProxyConfig;
  onConfigChange: (config: ProxyConfig) => Promise<void>;
  onError: (message: string | null) => void;
}

export function ProxyServiceControl({ config, onConfigChange, onError }: ProxyServiceControlProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const risk = useProxyRiskConfirmation();
  const [pending, setPending] = useState(false);
  const operationPending = useRef(false);
  const toggleButton = useRef<HTMLButtonElement>(null);

  const toggleService = async () => {
    if (operationPending.current) {
      return;
    }
    operationPending.current = true;
    setPending(true);
    try {
      if (config.enabled) {
        await ipc.client.gateway.stop();
        onError(null);
        await onConfigChange({ ...config, enabled: false });
        return;
      }

      const result = await ipc.client.gateway.start({ port: config.port });
      if (result.success) {
        onError(null);
        await onConfigChange({ ...config, port: result.port, enabled: true });
        return;
      }

      const description =
        result.reason === 'address-in-use'
          ? t('proxy.service.port_in_use_description', { port: result.port })
          : result.message;
      onError(description);
      await onConfigChange({ ...config, enabled: false });
      toast({
        title:
          result.reason === 'address-in-use'
            ? t('proxy.service.port_in_use_title')
            : t('proxy.service.start_failed'),
        description,
        variant: 'destructive',
      });
    } catch (error) {
      const description = error instanceof Error ? error.message : t('proxy.service.start_failed');
      onError(description);
      toast({ error, title: t('proxy.service.start_failed'), description, variant: 'destructive' });
    } finally {
      operationPending.current = false;
      setPending(false);
    }
  };

  const requestToggle = () => {
    if (!config.enabled && !risk.acknowledged) {
      risk.setOpen(true);
      return;
    }
    void toggleService();
  };

  const confirmStart = () => {
    if (operationPending.current) {
      return;
    }
    risk.acknowledge();
    void toggleService();
  };

  return (
    <>
      <Button
        ref={toggleButton}
        variant={config.enabled ? 'destructive' : 'default'}
        disabled={pending}
        aria-busy={pending}
        onClick={requestToggle}
      >
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        {config.enabled ? t('proxy.service.stop') : t('proxy.service.start')}
      </Button>
      <ProxyRiskConfirmation
        open={risk.open}
        onOpenChange={risk.setOpen}
        onConfirm={confirmStart}
        pending={pending}
        returnFocus={() => toggleButton.current?.focus()}
      />
    </>
  );
}
