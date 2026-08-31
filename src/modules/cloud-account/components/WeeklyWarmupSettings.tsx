import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  useSetWeeklyWarmupConfig,
  useWeeklyWarmupConfig,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import {
  DEFAULT_WEEKLY_WARMUP_CONFIG,
  type WeeklyWarmupGroup,
} from '@/modules/cloud-account/services/weekly-warmup-contract';

const GROUPS: WeeklyWarmupGroup[] = ['claude', 'gemini'];

export function WeeklyWarmupSettings() {
  const { t } = useTranslation();
  const {
    data: config = DEFAULT_WEEKLY_WARMUP_CONFIG,
    isLoading,
    isError,
    refetch,
  } = useWeeklyWarmupConfig();
  const mutation = useSetWeeklyWarmupConfig();
  const disabled = isLoading || isError || mutation.isPending;

  const updateGroup = (group: WeeklyWarmupGroup, enabled: boolean) => {
    const groups = enabled
      ? Array.from(new Set([...config.groups, group]))
      : config.groups.filter((candidate) => candidate !== group);
    mutation.mutate({ ...config, groups });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              {t('settings.weekly-warmup.title')}
            </CardTitle>
            <CardDescription>{t('settings.weekly-warmup.description')}</CardDescription>
          </div>
          <Switch
            aria-label={t('settings.weekly-warmup.enabled')}
            checked={config.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => mutation.mutate({ ...config, enabled })}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs">{t('settings.weekly-warmup.cost-notice')}</p>
        {(isError || mutation.isError) && (
          <p role="alert" className="text-destructive text-sm">
            {t('settings.weekly-warmup.error')}
          </p>
        )}
        {isError && (
          <Button
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            {t('settings.weekly-warmup.retry')}
          </Button>
        )}
        <p className="text-muted-foreground text-xs">{t('settings.weekly-warmup.groups')}</p>
        {GROUPS.map((group) => (
          <div key={group} className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor={`weekly-warmup-${group}`}>
              {t(`settings.weekly-warmup.group.${group}`)}
            </Label>
            <Switch
              id={`weekly-warmup-${group}`}
              checked={config.groups.includes(group)}
              disabled={disabled}
              onCheckedChange={(enabled) => updateGroup(group, enabled)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
