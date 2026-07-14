import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useCloudAccounts,
  useAutoSwitchModelsConfig,
  useSetAutoSwitchModelsConfig,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Search, RotateCcw, Save } from 'lucide-react';
import { filter, flatMap, includes, size, sortBy, uniq } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';

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

interface InnerProps {
  accounts: CloudAccount[] | undefined;
  initialConfig: Record<string, { enabled: boolean; priority: boolean }>;
}

function AutoSwitchModelSettingsInner({ accounts, initialConfig }: InnerProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const setConfigMutation = useSetAutoSwitchModelsConfig();

  const [searchQuery, setSearchQuery] = useState('');
  const [modelConfigMap, setModelConfigMap] =
    useState<Record<string, { enabled: boolean; priority: boolean }>>(initialConfig);

  // Get all unique models from all accounts
  const availableModelIds = useMemo(() => {
    return collectAvailableModelIds(accounts);
  }, [accounts]);

  // Filter models based on search term
  const filteredModelIds = useMemo(() => {
    return filterModelIdsByQuery(availableModelIds, searchQuery);
  }, [availableModelIds, searchQuery]);

  const handleSearchQueryChange = (nextQuery: string) => {
    setSearchQuery(nextQuery);
  };

  const handleIncludeChange = (modelId: string, checked: boolean) => {
    setModelConfigMap((prev) => {
      const existing = prev[modelId] || { enabled: true, priority: false };
      return {
        ...prev,
        [modelId]: {
          ...existing,
          enabled: checked,
          // Disable priority if excluded
          priority: checked ? existing.priority : false,
        },
      };
    });
  };

  const handlePriorityChange = (modelId: string, checked: boolean) => {
    setModelConfigMap((prev) => {
      const existing = prev[modelId] || { enabled: true, priority: false };
      return {
        ...prev,
        [modelId]: {
          ...existing,
          priority: checked,
        },
      };
    });
  };

  const resetConfigOverrides = () => {
    setModelConfigMap({});
  };

  const saveConfigSettings = async () => {
    try {
      await setConfigMutation.mutateAsync(modelConfigMap);
      toast({
        title: t('settings.autoSwitchModels.saved'),
        variant: 'default',
      });
    } catch (error) {
      console.error('Failed to save auto-switch model config:', error);
      toast({
        title: t('settings.autoSwitchModels.saveFailed'),
        variant: 'destructive',
      });
    }
  };

  const isModelEnabled = (modelId: string): boolean => {
    return modelConfigMap[modelId]?.enabled !== false;
  };

  const isModelPriority = (modelId: string): boolean => {
    return !!modelConfigMap[modelId]?.priority;
  };

  const isResetDisabled = useMemo(() => {
    return size(modelConfigMap) === 0;
  }, [modelConfigMap]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('settings.autoSwitchModels.title')}</span>
          <Badge variant="secondary">
            {t('settings.providerGroupings.models', { count: filteredModelIds.length })}
          </Badge>
        </CardTitle>
        <CardDescription>{t('settings.autoSwitchModels.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
          <Input
            placeholder={t('settings.autoSwitchModels.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => handleSearchQueryChange(event.target.value)}
            className="pl-10"
          />
        </div>

        {/* Model List */}
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-4">
          {filteredModelIds.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">
              {searchQuery
                ? t('settings.autoSwitchModels.noModelsFound')
                : t('settings.autoSwitchModels.noModels')}
            </div>
          ) : (
            filteredModelIds.map((modelId) => {
              const isEnabled = isModelEnabled(modelId);
              const isPriority = isModelPriority(modelId);
              return (
                <div
                  key={modelId}
                  className="hover:bg-muted/50 flex items-center justify-between rounded p-2"
                >
                  <div className="flex flex-1 items-center space-x-3">
                    <label className="text-sm font-medium">{modelId}</label>
                  </div>

                  <div className="flex items-center space-x-6">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`switch-enable-${modelId}`}
                        checked={isEnabled}
                        onCheckedChange={(checked) =>
                          handleIncludeChange(modelId, checked as boolean)
                        }
                      />
                      <label
                        htmlFor={`switch-enable-${modelId}`}
                        className="cursor-pointer text-xs font-medium text-gray-600 dark:text-gray-400"
                      >
                        {t('settings.autoSwitchModels.includeLabel')}
                      </label>
                    </div>

                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`switch-priority-${modelId}`}
                        checked={isPriority}
                        disabled={!isEnabled}
                        onCheckedChange={(checked) =>
                          handlePriorityChange(modelId, checked as boolean)
                        }
                      />
                      <label
                        htmlFor={`switch-priority-${modelId}`}
                        className={`cursor-pointer text-xs font-medium ${
                          isEnabled
                            ? 'text-gray-600 dark:text-gray-400'
                            : 'text-gray-300 dark:text-gray-700'
                        }`}
                      >
                        {t('settings.autoSwitchModels.priorityLabel')}
                      </label>
                    </div>

                    {isEnabled && isPriority && (
                      <Badge
                        variant="default"
                        className="bg-blue-600 text-xs text-white dark:bg-blue-700"
                      >
                        {t('settings.autoSwitchModels.priorityLabel')}
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-4">
          <Button
            variant="outline"
            onClick={resetConfigOverrides}
            disabled={isResetDisabled}
            className="flex items-center gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            {t('settings.modelVisibility.reset')}
          </Button>
          <Button
            onClick={saveConfigSettings}
            disabled={setConfigMutation.isPending}
            className="flex items-center gap-2"
          >
            {setConfigMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {setConfigMutation.isPending
              ? t('settings.autoSwitchModels.saving')
              : t('settings.autoSwitchModels.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function AutoSwitchModelSettings() {
  const { t } = useTranslation();
  const { data: accounts, isLoading: accountsLoading } = useCloudAccounts();
  const { data: currentConfig, isLoading: configLoading } = useAutoSwitchModelsConfig();

  if (accountsLoading || configLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-2">{t('common.loading')}</span>
        </CardContent>
      </Card>
    );
  }

  const configKey = JSON.stringify(currentConfig || {});

  return (
    <AutoSwitchModelSettingsInner
      key={configKey}
      accounts={accounts}
      initialConfig={currentConfig || {}}
    />
  );
}
