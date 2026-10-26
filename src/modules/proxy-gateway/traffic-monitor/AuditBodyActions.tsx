import { useEffect, useRef, useState } from 'react';
import { Check, Clipboard, Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { TrafficAuditBodyDescriptor } from '../audit/traffic-audit.types';

export function AuditBodyActions({
  body,
  content,
  disabled,
}: {
  body: TrafficAuditBodyDescriptor;
  content: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<'copy' | 'save' | null>(null);
  const active = useRef(false);
  const copying = useRef(false);
  const savePending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    if (copying.current) {
      return;
    }
    copying.current = true;
    clearTimeout(timer.current);
    setCopied(false);
    setError(null);
    try {
      await navigator.clipboard.writeText(content);
      if (active.current) {
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1_200);
      }
    } catch {
      if (active.current) {
        setError('copy');
      }
    } finally {
      copying.current = false;
    }
  };
  const save = async () => {
    if (savePending.current) {
      return;
    }
    savePending.current = true;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await window.electron.saveTrafficAuditBody(
        body.id,
        `traffic-${body.ownerKind}-${body.direction}-${body.id}.${body.kind === 'json' ? 'json' : 'txt'}`,
      );
      if (active.current) {
        setSaved(result.status === 'saved');
      }
    } catch {
      if (active.current) {
        setError('save');
      }
    } finally {
      savePending.current = false;
      if (active.current) {
        setSaving(false);
      }
    }
  };

  return (
    <>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label={t('traffic.copy-loaded')}
              disabled={disabled || content.length === 0}
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Clipboard className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('traffic.copy-loaded')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label={t('traffic.save-full')}
              disabled={disabled || saving || body.state === 'writing'}
              aria-busy={saving}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('traffic.save-full')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {t(`traffic.capture.${error}-failed`)}
        </span>
      )}
      {copied && (
        <span role="status" className="text-muted-foreground text-xs">
          {t('traffic.capture.copied')}
        </span>
      )}
      {saved && (
        <span role="status" className="text-muted-foreground text-xs">
          {t('traffic.capture.saved')}
        </span>
      )}
    </>
  );
}
