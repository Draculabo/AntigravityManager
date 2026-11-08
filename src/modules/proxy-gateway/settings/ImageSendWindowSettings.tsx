import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ipc } from '@/ipc/manager';
import type { ImageSchedulerConfig } from '@/modules/config/types';

type WindowConfig = Omit<ImageSchedulerConfig, 'per_account_concurrency'>;

export function ImageSendWindowSettings({
  config,
  available,
}: {
  config: ImageSchedulerConfig;
  available: boolean;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const pending = useRef(false);
  const [draft, setDraft] = useState<Partial<WindowConfig>>({});
  const [countDraft, setCountDraft] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    'saved' | 'pending' | 'failed' | 'invalid-count' | 'invalid-memory' | null
  >(null);
  const enabled = draft.send_window_enabled ?? config.send_window_enabled;
  const strategy = draft.send_window_strategy ?? config.send_window_strategy;
  const dirty = Object.keys(draft).length > 0 || countDraft !== null || memoryDraft !== null;

  const save = async () => {
    if (!available || pending.current) {
      return;
    }
    const change: Partial<WindowConfig> = { send_window_enabled: enabled };
    if (enabled) {
      change.send_window_strategy = strategy;
      if (strategy === 'count') {
        const raw = countDraft ?? String(config.send_window_count);
        const count = Number(raw);
        if (!/^\d+$/u.test(raw) || !Number.isInteger(count) || count > 256) {
          setFeedback('invalid-count');
          return;
        }
        change.send_window_count = count;
        change.send_window_strip_remote_urls =
          draft.send_window_strip_remote_urls ?? config.send_window_strip_remote_urls;
      } else {
        const raw = memoryDraft ?? String(config.send_window_memory_mib);
        const memory = Number(raw);
        if (!/^\d+$/u.test(raw) || !Number.isInteger(memory) || memory < 1 || memory > 512) {
          setFeedback('invalid-memory');
          return;
        }
        change.send_window_memory_mib = memory;
      }
    }
    pending.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await ipc.client.config.service.update({ proxy: { image_scheduler: change } });
      cache.setQueryData(['serviceConfig'], result.snapshot);
      setDraft({});
      setCountDraft(null);
      setMemoryDraft(null);
      setFeedback(result.state === 'applied' ? 'saved' : 'pending');
    } catch {
      setFeedback('failed');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('image-send-window.title')}</CardTitle>
        <CardDescription>{t('image-send-window.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" aria-busy={saving}>
        <fieldset disabled={!available || saving} className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="image-send-window-enabled">{t('image-send-window.enabled')}</Label>
              <p id="image-send-window-enabled-help" className="text-muted-foreground text-xs">
                {t('image-send-window.enabled-help')}
              </p>
            </div>
            <Switch
              id="image-send-window-enabled"
              aria-describedby="image-send-window-enabled-help"
              checked={enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, send_window_enabled: checked })}
            />
          </div>
          <fieldset disabled={!enabled} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="image-send-window-strategy">{t('image-send-window.strategy')}</Label>
              <Select
                value={strategy}
                onValueChange={(value) => {
                  if (value === 'count' || value === 'memory') {
                    setDraft({ ...draft, send_window_strategy: value });
                    setFeedback(null);
                  }
                }}
              >
                <SelectTrigger id="image-send-window-strategy" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="count">{t('image-send-window.strategy-count')}</SelectItem>
                  <SelectItem value="memory">{t('image-send-window.strategy-memory')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {strategy === 'count' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="image-send-window-count">{t('image-send-window.count')}</Label>
                  <Input
                    id="image-send-window-count"
                    type="number"
                    min={0}
                    max={256}
                    step={1}
                    className="w-32"
                    value={countDraft ?? config.send_window_count}
                    onChange={(event) => {
                      setCountDraft(event.target.value);
                      setFeedback(null);
                    }}
                    aria-describedby="image-send-window-count-help"
                    aria-invalid={feedback === 'invalid-count'}
                  />
                  <p id="image-send-window-count-help" className="text-muted-foreground text-xs">
                    {t('image-send-window.count-help')}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="image-send-window-remote">
                      {t('image-send-window.remote')}
                    </Label>
                    <p id="image-send-window-remote-help" className="text-muted-foreground text-xs">
                      {t('image-send-window.remote-help')}
                    </p>
                  </div>
                  <Switch
                    id="image-send-window-remote"
                    checked={
                      draft.send_window_strip_remote_urls ?? config.send_window_strip_remote_urls
                    }
                    aria-describedby="image-send-window-remote-help"
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, send_window_strip_remote_urls: checked })
                    }
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="image-send-window-memory">{t('image-send-window.memory')}</Label>
                <Input
                  id="image-send-window-memory"
                  type="number"
                  min={1}
                  max={512}
                  step={1}
                  className="w-32"
                  value={memoryDraft ?? config.send_window_memory_mib}
                  onChange={(event) => {
                    setMemoryDraft(event.target.value);
                    setFeedback(null);
                  }}
                  aria-describedby="image-send-window-memory-help"
                  aria-invalid={feedback === 'invalid-memory'}
                />
                <p id="image-send-window-memory-help" className="text-muted-foreground text-xs">
                  {t('image-send-window.memory-help')}
                </p>
              </div>
            )}
          </fieldset>
          <Button variant="outline" size="sm" disabled={!dirty} onClick={() => void save()}>
            {t(saving ? 'image-send-window.saving' : 'image-send-window.save')}
          </Button>
        </fieldset>
        <p className="text-muted-foreground text-xs">{t('image-send-window.admission-help')}</p>
        <p className="text-muted-foreground text-xs">{t('image-send-window.retention-help')}</p>
        {!available && (
          <p role="alert" className="text-destructive text-sm">
            {t('image-send-window.unavailable')}
          </p>
        )}
        {feedback && (
          <p
            role={feedback === 'saved' || feedback === 'pending' ? 'status' : 'alert'}
            className="text-sm"
          >
            {t(`image-send-window.${feedback}`)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
