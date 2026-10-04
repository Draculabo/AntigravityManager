import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { useSetAccountProxy } from '@/modules/cloud-account/hooks/useCloudAccounts';
import { isValidProxyUrl } from '@/shared/utils/url';

interface CloudAccountProxyEditorProps {
  accountId: string;
  configured: boolean;
}

/** Edits one account's proxy without reading a credential-bearing URL into the renderer. */
export function CloudAccountProxyEditor({ accountId, configured }: CloudAccountProxyEditorProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const setAccountProxy = useSetAccountProxy();
  const [proxyUrl, setProxyUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    },
    [],
  );

  const showSaved = () => {
    setSaved(true);
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
  };

  const showError = () => {
    toast({ title: t('cloud.card.proxy-save-failed'), variant: 'destructive' });
  };

  const saveReplacement = (event: FocusEvent<HTMLInputElement>) => {
    if (clearButtonRef.current && event.relatedTarget === clearButtonRef.current) {
      return;
    }
    const trimmed = proxyUrl.trim();
    if (!trimmed) {
      return;
    }
    if (!isValidProxyUrl(trimmed)) {
      showError();
      return;
    }
    setAccountProxy.mutate(
      { accountId, proxyUrl: trimmed },
      {
        onSuccess: () => {
          setProxyUrl('');
          showSaved();
        },
        onError: showError,
      },
    );
  };

  return (
    <>
      <div className="relative min-w-0 flex-1">
        <Input
          value={proxyUrl}
          aria-label={
            configured
              ? t('cloud.card.proxy-replace-placeholder')
              : t('cloud.card.proxyPlaceholder')
          }
          onChange={(event) => {
            setProxyUrl(event.target.value);
            setSaved(false);
          }}
          onBlur={saveReplacement}
          placeholder={
            configured
              ? t('cloud.card.proxy-replace-placeholder')
              : t('cloud.card.proxyPlaceholder')
          }
          disabled={setAccountProxy.isPending}
          className="bg-muted/20 border-border/40 focus-visible:bg-background focus-visible:ring-primary/30 h-7 w-full rounded-md text-[11px] transition-all focus-visible:ring-1"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
        {saved && (
          <span className="bg-background absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-[9px] font-semibold text-green-500">
            {t('cloud.card.proxySaved')}
          </span>
        )}
      </div>
      {configured && (
        <Button
          ref={clearButtonRef}
          variant="outline"
          size="icon"
          className="border-border/50 h-7 w-7 shrink-0"
          aria-label={t('cloud.card.proxy-remove')}
          title={t('cloud.card.proxy-remove')}
          disabled={setAccountProxy.isPending}
          onClick={() => {
            setAccountProxy.mutate(
              { accountId, proxyUrl: null },
              {
                onSuccess: () => {
                  setProxyUrl('');
                  showSaved();
                },
                onError: showError,
              },
            );
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </>
  );
}
