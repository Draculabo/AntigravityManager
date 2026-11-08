import { Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ProxyRiskConfirmation, useProxyRiskConfirmation } from './ProxyRiskConfirmation';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
import type { GatewayChoicePersistence, GatewayRememberChoice } from '../services/gateway-management.schema';

interface ProxyServiceControlProps {
  config: ServiceConfigSnapshot['proxy'];
  running: boolean;
  onRuntimeChange?: () => void | Promise<unknown>;
  onError: (message: string | null) => void;
}

export function ProxyServiceControl({ config, running, onRuntimeChange, onError }: ProxyServiceControlProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const risk = useProxyRiskConfirmation();
  const [pending, setPending] = useState(false);
  const [unsaved, setUnsaved] = useState<GatewayRememberChoice | null>(null);
  const [actualRunning, setActualRunning] = useState<boolean | null>(null);
  const [previousRunning, setPreviousRunning] = useState(running);
  const operationPending = useRef(false);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const active = actualRunning ?? running;
  if (previousRunning !== running) {
    setPreviousRunning(running);
    setActualRunning(null);
  }

  const reportPersistence = (result: GatewayChoicePersistence) => {
    if (result.state === 'failed') {
      setUnsaved(result.choice);
      const description = result.choice.enabled
        ? t('proxy.service.persistence-failed-started')
        : t('proxy.service.persistence-failed-stopped');
      onError(description);
      toast({ title: description, description: t('proxy.service.persistence-diagnostic', { diagnosticId: result.diagnosticId }), variant: 'destructive' });
    } else if (result.state === 'saved') {
      setUnsaved(null);
      onError(null);
    }
  };

  const refresh = async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ['serviceConfig'] }),
      queryClient.invalidateQueries({ queryKey: ['gatewayStatus'] }),
      Promise.resolve().then(() => onRuntimeChange?.()),
    ]);
    // A failed readback must retain the already confirmed operation state.
    try {
      const status = await ipc.client.gateway.status();
      setActualRunning(status.running);
    } catch {
      // The parent owns the persistent runtime-status error and its explicit read retry.
    }
  };

  const retrySave = async () => {
    if (!unsaved || operationPending.current) {
      return;
    }
    operationPending.current = true;
    setPending(true);
    try {
      reportPersistence(await ipc.client.gateway.retrySaveChoice(unsaved));
      await refresh();
    } catch (error) {
      toast({ error, title: t('proxy.service.retry-save-failed'), variant: 'destructive' });
    } finally {
      operationPending.current = false;
      setPending(false);
    }
  };

  const toggleService = async (start: boolean) => {
    if (operationPending.current) {
      return;
    }
    operationPending.current = true;
    setPending(true);
    try {
      const status = await ipc.client.gateway.status();
      setActualRunning(status.running);
      if (!start) {
        const result = await ipc.client.gateway.manualStop();
        if (!result.success) {
          throw new Error(t('proxy.service.stop-failed'));
        }
        setActualRunning(false);
        reportPersistence(result.persistence);
      } else {
        const result = await ipc.client.gateway.manualStart({ port: config.port });
        if (!result.operation.success) {
          const description = result.operation.reason === 'address-in-use'
            ? t('proxy.service.port_in_use_description', { port: result.operation.port })
            : t('proxy.service.start_failed');
          onError(description);
          toast({ title: t('proxy.service.start_failed'), description, variant: 'destructive' });
          return;
        }
        setActualRunning(true);
        reportPersistence(result.persistence);
      }
    } catch (error) {
      const description = t('proxy.service.operation-failed');
      onError(description);
      toast({ error, title: description, variant: 'destructive' });
    } finally {
      await refresh();
      operationPending.current = false;
      setPending(false);
    }
  };

  const requestToggle = () => {
    if (!active && !risk.acknowledged) {
      risk.setOpen(true);
      return;
    }
    void toggleService(!active);
  };
  const confirmStart = () => {
    if (!operationPending.current) {
      risk.acknowledge();
      void toggleService(true);
    }
  };

  return (
    <>
      <Button ref={toggleButton} variant={active ? 'destructive' : 'default'} disabled={pending} aria-busy={pending} onClick={requestToggle}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        {active ? t('proxy.service.stop') : t('proxy.service.start')}
      </Button>
      {unsaved && (
        <Button variant="outline" disabled={pending} onClick={() => void retrySave()}>
          {t('proxy.service.retry-save')}
        </Button>
      )}
      <ProxyRiskConfirmation open={risk.open} onOpenChange={risk.setOpen} onConfirm={confirmStart} pending={pending} returnFocus={() => toggleButton.current?.focus()} />
    </>
  );
}
