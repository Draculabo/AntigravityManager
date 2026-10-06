import { Loader2, ShieldAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];

const RISK_ACKNOWLEDGEMENT_KEY = 'proxy-risk-acknowledged:v1';

function readRiskAcknowledgement(): boolean {
  try {
    return localStorage.getItem(RISK_ACKNOWLEDGEMENT_KEY) === 'acknowledged';
  } catch {
    // An unavailable preference store must still show the warning.
    return false;
  }
}

interface ProxyServiceControlProps {
  config: ProxyConfig;
  onConfigChange: (config: ProxyConfig) => Promise<void>;
  onError: (message: string | null) => void;
}

export function ProxyServiceControl({ config, onConfigChange, onError }: ProxyServiceControlProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [acknowledged, setAcknowledged] = useState(readRiskAcknowledgement);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      toast({
        title: t('proxy.service.start_failed'),
        description,
        variant: 'destructive',
      });
    } finally {
      operationPending.current = false;
      setPending(false);
    }
  };

  const requestToggle = () => {
    if (!config.enabled && !acknowledged) {
      setConfirmOpen(true);
      return;
    }
    void toggleService();
  };

  const confirmStart = () => {
    if (operationPending.current) {
      return;
    }
    try {
      localStorage.setItem(RISK_ACKNOWLEDGEMENT_KEY, 'acknowledged');
    } catch {
      // Keep this explicit acknowledgement in memory if persistence is unavailable.
      console.warn('Proxy risk acknowledgement could not be persisted');
    }
    setAcknowledged(true);
    setConfirmOpen(false);
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
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            toggleButton.current?.focus();
          }}
        >
          <DialogHeader className="space-y-3">
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 shrink-0 text-amber-600" aria-hidden="true" />
              {t('proxy.risk-confirmation.title')}
            </DialogTitle>
            <DialogDescription className="text-left leading-relaxed whitespace-pre-line">
              {t('proxy.risk-confirmation.description')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            {t('proxy.risk-confirmation.account-advice')}
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" autoFocus onClick={() => setConfirmOpen(false)}>
              {t('proxy.risk-confirmation.cancel')}
            </Button>
            <Button onClick={confirmStart} disabled={pending}>
              {t('proxy.risk-confirmation.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
