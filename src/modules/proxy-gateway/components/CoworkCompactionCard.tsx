import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { CoworkCompactionConfig } from '@/modules/config/types';

interface CoworkCompactionCardProps {
  config: CoworkCompactionConfig;
  onChange: (config: CoworkCompactionConfig) => void | Promise<void>;
}

export function CoworkCompactionCard({ config, onChange }: CoworkCompactionCardProps) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(String(config.auto_threshold));

  useEffect(() => {
    setThreshold(String(config.auto_threshold));
  }, [config.auto_threshold]);

  const commitThreshold = () => {
    const parsed = Number(threshold);
    const value = Number.isFinite(parsed)
      ? Math.min(2_000_000, Math.max(50_000, Math.round(parsed)))
      : config.auto_threshold;
    setThreshold(String(value));
    if (value !== config.auto_threshold) {
      void onChange({ ...config, auto_threshold: value });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('proxy.compaction.title')}</CardTitle>
        <CardDescription>{t('proxy.compaction.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="cowork-auto-compaction">{t('proxy.compaction.auto')}</Label>
            <p className="text-muted-foreground text-xs">{t('proxy.compaction.auto-desc')}</p>
          </div>
          <Switch
            id="cowork-auto-compaction"
            checked={config.auto_enabled}
            onCheckedChange={(auto_enabled) => void onChange({ ...config, auto_enabled })}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="cowork-manual-compaction">{t('proxy.compaction.manual')}</Label>
            <p className="text-muted-foreground text-xs">{t('proxy.compaction.manual-desc')}</p>
          </div>
          <Switch
            id="cowork-manual-compaction"
            checked={config.manual_enabled}
            onCheckedChange={(manual_enabled) => void onChange({ ...config, manual_enabled })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cowork-auto-threshold">{t('proxy.compaction.threshold')}</Label>
          <Input
            id="cowork-auto-threshold"
            type="number"
            min={50_000}
            max={2_000_000}
            step={1_000}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitThreshold();
              }
            }}
          />
          <p className="text-muted-foreground text-xs">{t('proxy.compaction.threshold-desc')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
