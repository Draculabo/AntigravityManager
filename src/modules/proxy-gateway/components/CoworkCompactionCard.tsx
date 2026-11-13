import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { CoworkCompactionConfig } from '@/modules/config/types';

interface CoworkCompactionCardProps {
  config: CoworkCompactionConfig;
  apiKeyConfigured: boolean;
  revealApiKey: () => Promise<string>;
  onChange: (config: CoworkCompactionConfig) => void | Promise<void>;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'failed'; retry: () => Promise<void> };

export function CoworkCompactionCard({
  config,
  apiKeyConfigured,
  revealApiKey,
  onChange,
}: CoworkCompactionCardProps) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(String(config.auto_threshold));
  const [previousThreshold, setPreviousThreshold] = useState(config.auto_threshold);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const saving = useRef(false);
  const current = useRef({ config, onChange });
  const pending = saveState.kind === 'pending';

  useEffect(() => {
    current.current = { config, onChange };
  }, [config, onChange]);

  const runChange = async (change: () => Promise<void>) => {
    if (saving.current) {
      return;
    }
    saving.current = true;
    setSaveState({ kind: 'pending' });
    try {
      await change();
      setSaveState({ kind: 'idle' });
    } catch {
      setSaveState({ kind: 'failed', retry: change });
    } finally {
      saving.current = false;
    }
  };

  const save = (patch: Partial<CoworkCompactionConfig>) =>
    runChange(async () => {
      await current.current.onChange({ ...current.current.config, ...patch });
    });

  const trustCurrentCredential = () =>
    runChange(async () => {
      const key = await revealApiKey();
      if (!key) {
        throw new Error('The proxy API key is unavailable.');
      }
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const digest = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const latest = current.current.config;
      if (!latest.trusted_client_key_hashes.includes(digest)) {
        await current.current.onChange({
          ...latest,
          trusted_client_key_hashes: [...latest.trusted_client_key_hashes, digest],
        });
      }
    });

  if (previousThreshold !== config.auto_threshold) {
    setPreviousThreshold(config.auto_threshold);
    setThreshold(String(config.auto_threshold));
  }

  const commitThreshold = () => {
    const parsed = Number(threshold);
    const value = Number.isFinite(parsed)
      ? Math.min(2_000_000, Math.max(50_000, Math.round(parsed)))
      : config.auto_threshold;
    setThreshold(String(value));
    if (value !== config.auto_threshold) {
      void save({ auto_threshold: value });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('proxy.config.compaction.title')}</CardTitle>
        <CardDescription>{t('proxy.config.compaction.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('proxy.config.compaction.trusted-sources')}</p>
          <p className="text-muted-foreground text-xs">{t('proxy.config.compaction.trust-desc')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={pending || !apiKeyConfigured || config.trusted_client_key_hashes.length >= 32}
            onClick={() => void trustCurrentCredential()}
          >
            {t('proxy.config.compaction.trust-current-key')}
          </Button>
          {!apiKeyConfigured ? (
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.compaction.key-required')}
            </p>
          ) : null}
          {config.trusted_client_key_hashes.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.compaction.no-trusted-sources')}
            </p>
          ) : (
            <ul className="space-y-2">
              {config.trusted_client_key_hashes.map((digest) => (
                <li key={digest} className="flex flex-wrap items-center justify-between gap-2">
                  <code className="text-muted-foreground text-xs" title={digest}>
                    {digest.slice(0, 12)}…{digest.slice(-8)}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={pending}
                    aria-label={t('proxy.config.compaction.revoke-key-label', { digest })}
                    onClick={() =>
                      void save({
                        trusted_client_key_hashes: config.trusted_client_key_hashes.filter(
                          (value) => value !== digest,
                        ),
                      })
                    }
                  >
                    {t('proxy.config.compaction.revoke-key')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {config.trusted_client_key_hashes.length >= 32 ? (
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.compaction.trust-limit')}
            </p>
          ) : null}
        </div>
        {pending ? (
          <p role="status" className="text-muted-foreground text-xs">
            {t('proxy.config.compaction.saving')}
          </p>
        ) : null}
        {saveState.kind === 'failed' ? (
          <div role="alert" className="space-y-2">
            <p className="text-destructive text-xs">{t('proxy.config.compaction.save-failed')}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void runChange(saveState.retry)}
            >
              {t('proxy.config.compaction.retry')}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="cowork-auto-compaction">{t('proxy.config.compaction.auto')}</Label>
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.compaction.auto-desc')}
            </p>
          </div>
          <Switch
            id="cowork-auto-compaction"
            checked={config.auto_enabled}
            disabled={pending}
            onCheckedChange={(auto_enabled) => void save({ auto_enabled })}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="cowork-manual-compaction">{t('proxy.config.compaction.manual')}</Label>
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.compaction.manual-desc')}
            </p>
          </div>
          <Switch
            id="cowork-manual-compaction"
            checked={config.manual_enabled}
            disabled={pending}
            onCheckedChange={(manual_enabled) => void save({ manual_enabled })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cowork-auto-threshold">{t('proxy.config.compaction.threshold')}</Label>
          <Input
            id="cowork-auto-threshold"
            type="number"
            min={50_000}
            max={2_000_000}
            step={1_000}
            value={threshold}
            disabled={pending}
            onChange={(event) => setThreshold(event.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitThreshold();
              }
            }}
          />
          <p className="text-muted-foreground text-xs">
            {t('proxy.config.compaction.threshold-desc')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
