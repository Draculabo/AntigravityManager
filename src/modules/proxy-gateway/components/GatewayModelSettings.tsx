import { ThinkingBudgetSettings } from '@/modules/config/components/ThinkingBudgetSettings';
import { getConfiguredModelMapping } from '@/modules/config/model-aliases';
import { GlobalSystemPromptCard } from './GlobalSystemPromptCard';
import { CoworkCompactionCard } from './CoworkCompactionCard';
import { ModelAliasEditor } from './ModelAliasEditor';
import { ProxyAccountStrategy } from './ProxyAccountStrategy';
import type { Dispatch, SetStateAction } from 'react';
import type {
  ServiceConfigSnapshot,
  ServiceConfigWriteResult,
} from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ANTHROPIC_ROUTE_OPTIONS = [
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gemini-3-flash',
  'gemini-3.1-pro-low',
] as const;

const DEFAULT_ANTHROPIC_MAPPING: Record<string, string> = {
  'claude-sonnet-4-6-20260219': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-20260201': 'claude-opus-4-6-thinking',
  opus: 'claude-opus-4-6-thinking',
};

function resolveAnthropicMappingValue(
  anthropicMapping: Record<string, string>,
  keys: string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = anthropicMapping[key];
    if (value) {
      return value;
    }
  }
  return fallback;
}

export function GatewayModelSettings({
  proxyConfig,
  updateProxyConfig,
  setProxyConfig,
  onApplicationResult,
  onSaved,
}: {
  proxyConfig: ProxyConfig;
  updateProxyConfig(next: ProxyConfig): Promise<void>;
  setProxyConfig: Dispatch<SetStateAction<ProxyConfig | undefined>>;
  onApplicationResult(result: ServiceConfigWriteResult): void;
  onSaved(): Promise<void>;
}) {
  const { t } = useTranslation();
  const updateAnthropicMapping = (mappingPatch: Record<string, string>) => {
    if (!proxyConfig) {
      return;
    }
    updateProxyConfig({
      ...proxyConfig,
      model_aliases: [
        ...proxyConfig.model_aliases.map((route) =>
          mappingPatch[route.alias]
            ? { ...route, target: mappingPatch[route.alias], enabled: true }
            : route,
        ),
        ...Object.entries(mappingPatch)
          .filter(([alias]) => !proxyConfig.model_aliases.some((route) => route.alias === alias))
          .map(([alias, target]) => ({ alias, target, enabled: true })),
      ],
      custom_mapping: {},
      anthropic_mapping: {},
    });
  };

  return (
    <details className="bg-card rounded-lg border p-4">
      <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
        {t('proxy.workspace.models')}
      </summary>
      <div className="mt-4 space-y-4">
        <details className="group border-t pt-4">
          <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
            {t('proxy.advanced-options')}
          </summary>
          <p className="text-muted-foreground mt-1 text-xs">{t('proxy.advanced-description')}</p>
          <div className="mt-4 space-y-4">
            <ProxyAccountStrategy
              value={proxyConfig.account_selection_strategy}
              weeklyQuotaPriorityEnabled={proxyConfig.weekly_quota_priority_enabled}
              onChange={async (account_selection_strategy) => {
                const previous = proxyConfig;
                try {
                  await updateProxyConfig({ ...proxyConfig, account_selection_strategy });
                } catch (error) {
                  setProxyConfig(previous);
                  throw error;
                }
              }}
              onWeeklyQuotaPriorityChange={async (weekly_quota_priority_enabled) => {
                const previous = proxyConfig;
                try {
                  await updateProxyConfig({ ...proxyConfig, weekly_quota_priority_enabled });
                } catch (error) {
                  setProxyConfig(previous);
                  throw error;
                }
              }}
            />

            <GlobalSystemPromptCard
              config={proxyConfig.global_system_prompt}
              onChange={(global_system_prompt) =>
                updateProxyConfig({ ...proxyConfig, global_system_prompt })
              }
            />
            <CoworkCompactionCard
              config={proxyConfig.cowork_compaction}
              apiKeyConfigured={proxyConfig.api_key_configured}
              revealApiKey={async () => {
                const result = await ipc.client.config.service.revealSecret({
                  name: 'api-key',
                });
                return result.value;
              }}
              onChange={async (cowork_compaction) => {
                const previous = proxyConfig;
                try {
                  await updateProxyConfig({ ...proxyConfig, cowork_compaction });
                } catch (error) {
                  setProxyConfig((current) =>
                    current?.cowork_compaction === cowork_compaction
                      ? { ...current, cowork_compaction: previous.cowork_compaction }
                      : current,
                  );
                  throw error;
                }
              }}
            />

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-1">
                <Label>{t('proxy.config.cloud_code_meta')}</Label>
                <p className="text-xs text-gray-500">{t('proxy.config.cloud_code_meta_desc')}</p>
              </div>
              <Switch
                checked={proxyConfig.experimental.enable_cloud_code_meta}
                onCheckedChange={(checked) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    experimental: {
                      ...proxyConfig.experimental,
                      enable_cloud_code_meta: checked,
                    },
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="proxy-allow-local-video-paths">
                  {t('proxy.config.allow-local-video-paths')}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t('proxy.config.allow-local-video-paths-desc')}
                </p>
              </div>
              <Switch
                id="proxy-allow-local-video-paths"
                checked={proxyConfig.experimental.allow_local_video_paths}
                onCheckedChange={(checked) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    experimental: {
                      ...proxyConfig.experimental,
                      allow_local_video_paths: checked,
                    },
                  })
                }
              />
            </div>
          </div>
        </details>
        <Card className="shadow-none">
          <CardHeader className="p-4">
            <CardTitle>{t('proxy.mapping.title')}</CardTitle>
            <CardDescription>{t('proxy.mapping.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4 pt-0">
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-1">
                <Label>{t('proxy.mapping.only-raw-quota-models')}</Label>
                <p className="text-xs text-gray-500">
                  {t('proxy.mapping.only-raw-quota-models-desc')}
                </p>
              </div>
              <Switch
                checked={proxyConfig.only_raw_quota_models}
                onCheckedChange={(checked) =>
                  updateProxyConfig({ ...proxyConfig, only_raw_quota_models: checked })
                }
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Sonnet 4.6 Card */}
              <div className="bg-muted/20 flex flex-col rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="bg-muted-foreground h-2 w-2 rounded-full"></div>
                  <h3 className="text-base leading-6 font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100">
                    Claude Sonnet 4.6 (Thinking)
                  </h3>
                </div>
                <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                  {t('proxy.mapping.maps_to')}
                </p>
                <Select
                  value={resolveAnthropicMappingValue(
                    getConfiguredModelMapping(proxyConfig),
                    ['claude-sonnet-4-6-20260219', 'claude-sonnet-4-5-20250929'],
                    'claude-sonnet-4-6-thinking',
                  )}
                  onValueChange={(value) =>
                    updateAnthropicMapping({
                      'claude-sonnet-4-6-20260219': value,
                      'claude-sonnet-4-5-20250929': value,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANTHROPIC_ROUTE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Opus 4.6 Card */}
              <div className="bg-muted/20 flex flex-col rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="bg-muted-foreground h-2 w-2 rounded-full"></div>
                  <h3 className="text-base leading-6 font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100">
                    Claude Opus 4.6 (Thinking)
                  </h3>
                </div>
                <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                  {t('proxy.mapping.maps_to')}
                </p>
                <Select
                  value={resolveAnthropicMappingValue(
                    getConfiguredModelMapping(proxyConfig),
                    ['claude-opus-4-6-20260201', 'opus'],
                    'claude-opus-4-6-thinking',
                  )}
                  onValueChange={(value) =>
                    updateAnthropicMapping({
                      'claude-opus-4-6-20260201': value,
                      opus: value,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANTHROPIC_ROUTE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateAnthropicMapping(DEFAULT_ANTHROPIC_MAPPING)}
              >
                {t('proxy.mapping.restore')}
              </Button>
            </div>
            <ModelAliasEditor
              routes={proxyConfig.model_aliases}
              onSave={async (routes) => {
                await updateProxyConfig({
                  ...proxyConfig,
                  model_aliases: routes,
                  custom_mapping: {},
                  anthropic_mapping: {},
                });
              }}
            />
          </CardContent>
        </Card>
        <ThinkingBudgetSettings
          onApplicationResult={onApplicationResult}
          config={proxyConfig.thinking_budget}
          available
          onSaved={onSaved}
        />
      </div>
    </details>
  );
}
