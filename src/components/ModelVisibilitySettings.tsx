import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '@/hooks/useAppConfig';
import { useCloudAccounts } from '@/hooks/useCloudAccounts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Loader2, Search, RotateCcw, Save } from 'lucide-react';
import { filter, flatMap, includes, size, sortBy, sumBy, uniq, values } from 'lodash-es';
import type { CloudAccount } from '@/types/cloudAccount';

function collectAvailableModelIds(accounts: CloudAccount[] | undefined): string[] {
  if (!accounts) {
    return [];
  }

  const modelNames = flatMap(accounts, (account) => {
    if (!account.quota?.models) {
      return [];
    }

    return Object.keys(account.quota.models);
  });

  return sortBy(uniq(modelNames));
}

function filterModelIdsByQuery(modelIds: string[], query: string): string[] {
  const normalizedSearchQuery = query.toLowerCase();

  return filter(modelIds, (modelId) => includes(modelId.toLowerCase(), normalizedSearchQuery));
}

export function ModelVisibilitySettings() {
  const { t } = useTranslation();
  const { config, saveConfig } = useAppConfig();
  const { data: accounts, isLoading: accountsLoading } = useCloudAccounts();

  const [searchQuery, setSearchQuery] = useState('');
  const [modelVisibilityMap, setModelVisibilityMap] = useState<Record<string, boolean>>({});
  const [providerGroupingEnabled, setProviderGroupingEnabled] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Initialize model visibility and provider groupings from config
  useEffect(() => {
    if (config?.model_visibility) {
      setModelVisibilityMap(config.model_visibility);
    }
    if (config?.provider_groupings_enabled !== undefined) {
      setProviderGroupingEnabled(config.provider_groupings_enabled);
    }
  }, [config?.model_visibility, config?.provider_groupings_enabled]);

  // Get all unique models from all accounts
  const availableModelIds = useMemo(() => {
    return collectAvailableModelIds(accounts);
  }, [accounts]);

  // Filter models based on search term
  const filteredModelIds = useMemo(() => {
    return filterModelIdsByQuery(availableModelIds, searchQuery);
  }, [availableModelIds, searchQuery]);

  const hiddenModelCount = useMemo(() => {
    return sumBy(values(modelVisibilityMap), (isVisible) => (isVisible === false ? 1 : 0));
  }, [modelVisibilityMap]);

  const isModelVisible = (modelId: string): boolean => {
    return modelVisibilityMap[modelId] !== false;
  };

  // Reset to defaults (all models visible)
  const resetVisibilityOverrides = () => {
    setModelVisibilityMap({});
  };

  // Save configuration
  const saveVisibilitySettings = async () => {
    if (!config) {
      return;
    }

    setIsSavingSettings(true);
    try {
      const nextConfig = {
        ...config,
        model_visibility: modelVisibilityMap,
        provider_groupings_enabled: providerGroupingEnabled,
      };
      await saveConfig(nextConfig);
    } catch (error) {
      console.error('Failed to save model visibility settings:', error);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSearchQueryChange = (nextQuery: string) => {
    setSearchQuery(nextQuery);
  };

  const handleProviderGroupingToggle = (checked: boolean) => {
    setProviderGroupingEnabled(checked);
  };

  const handleModelVisibilityChange = (modelId: string, checked: boolean) => {
    setModelVisibilityMap((prev) => ({
      ...prev,
      [modelId]: checked,
    }));
  };

  if (accountsLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-2">{t('common.loading')}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('settings.modelVisibility.title')}</span>
          <Badge variant="secondary">
            {t('settings.providerGroupings.models', { count: filteredModelIds.length })}
          </Badge>
        </CardTitle>
        <CardDescription>{t('settings.modelVisibility.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
          <Input
            placeholder={t('settings.modelVisibility.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => handleSearchQueryChange(event.target.value)}
            className="pl-10"
          />
        </div>

        {/* Provider Groupings Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="provider-groupings" className="text-sm font-medium">
              {t('settings.providerGroupings.enabled')}
            </Label>
            <p className="text-muted-foreground text-xs">
              {t('settings.providerGroupings.description')}
            </p>
          </div>
          <Switch
            id="provider-groupings"
            checked={providerGroupingEnabled}
            onCheckedChange={handleProviderGroupingToggle}
          />
        </div>

        {/* Model List */}
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-4">
          {filteredModelIds.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">
              {searchQuery
                ? t('settings.modelVisibility.noModelsFound')
                : t('settings.modelVisibility.noModels')}
            </div>
          ) : (
            filteredModelIds.map((modelId) => {
              const isVisible = isModelVisible(modelId);
              return (
                <div
                  key={modelId}
                  className="hover:bg-muted/50 flex items-center space-x-3 rounded p-2"
                >
                  <Checkbox
                    id={`model-${modelId}`}
                    checked={isVisible}
                    onCheckedChange={(checked) =>
                      handleModelVisibilityChange(modelId, checked as boolean)
                    }
                  />
                  <label
                    htmlFor={`model-${modelId}`}
                    className="flex-1 cursor-pointer text-sm font-medium"
                  >
                    {modelId}
                  </label>
                  {!isVisible && (
                    <Badge variant="secondary" className="text-xs">
                      {t('settings.modelVisibility.hidden')}
                    </Badge>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-4">
          <Button
            variant="outline"
            onClick={resetVisibilityOverrides}
            disabled={size(modelVisibilityMap) === 0}
            className="flex items-center gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            {t('settings.modelVisibility.reset')}
          </Button>
          <Button
            onClick={saveVisibilitySettings}
            disabled={isSavingSettings}
            className="flex items-center gap-2"
          >
            {isSavingSettings ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {isSavingSettings
              ? t('settings.modelVisibility.saving')
              : t('settings.modelVisibility.save')}
          </Button>
        </div>

        {/* Statistics */}
        <div className="text-muted-foreground border-t pt-2 text-sm">
          <div className="flex justify-between">
            <span>
              {t('settings.modelVisibility.totalModels')}: {availableModelIds.length}
            </span>
            <span>
              {t('settings.modelVisibility.visibleModels')}:{' '}
              {availableModelIds.length - hiddenModelCount}
            </span>
            <span>
              {t('settings.modelVisibility.hiddenModels')}: {hiddenModelCount}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
