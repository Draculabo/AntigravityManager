import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
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

const RISK_ACKNOWLEDGEMENT_KEY = 'proxy-risk-acknowledged:v1';

export function useProxyRiskConfirmation() {
  const [acknowledged, setAcknowledged] = useState(() => {
    try {
      return localStorage.getItem(RISK_ACKNOWLEDGEMENT_KEY) === 'acknowledged';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const acknowledge = () => {
    try {
      localStorage.setItem(RISK_ACKNOWLEDGEMENT_KEY, 'acknowledged');
    } catch {
      // Explicit consent remains valid for this mounted control when storage is unavailable.
      console.warn('Proxy risk acknowledgement could not be persisted');
    }
    setAcknowledged(true);
    setOpen(false);
  };
  return { acknowledged, open, setOpen, acknowledge };
}

export function ProxyRiskConfirmation({
  open,
  onOpenChange,
  onConfirm,
  pending,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  returnFocus: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
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
          <Button variant="outline" autoFocus onClick={() => onOpenChange(false)}>
            {t('proxy.risk-confirmation.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {t('proxy.risk-confirmation.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
