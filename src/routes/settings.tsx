import { createFileRoute } from '@tanstack/react-router';
import { useTheme } from '@/components/theme-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useQuery } from '@tanstack/react-query';
import { getAppVersion, getPlatform } from '@/actions/app';
import { useTranslation } from 'react-i18next';
import { setAppLanguage } from '@/actions/language';
import { useAppConfig } from '@/hooks/useAppConfig';
import { Loader2, FolderOpen, Bell } from 'lucide-react';
import { useState, useEffect } from 'react';
import { ProxyConfig } from '@/types/config';
import { openLogDirectory } from '@/actions/system';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { sendTestNotification } from '@/actions/notification';

function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { config, isLoading, saveConfig } = useAppConfig();

  // Local state for configuration editing
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | undefined>(undefined);

  // Local state for notification thresholds (smooth slider dragging)
  const [localWarningThreshold, setLocalWarningThreshold] = useState<number>(20);
  const [localSwitchThreshold, setLocalSwitchThreshold] = useState<number>(5);

  // Sync config to local state when loaded
  useEffect(() => {
    if (config) {
      // eslint-disable-next-line
      setProxyConfig(config.proxy);
      setLocalWarningThreshold(config.notifications?.quota_warning_threshold ?? 20);
      setLocalSwitchThreshold(config.notifications?.quota_switch_threshold ?? 5);
    }
  }, [config]);

  const { data: appVersion } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: getAppVersion,
  });

  const { data: platform } = useQuery({
    queryKey: ['app', 'platform'],
    queryFn: getPlatform,
  });

  const isAutoStartSupported =
    platform === 'win32' || platform === 'darwin' || platform === 'linux';
  const isMac = platform === 'darwin';

  const handleLanguageChange = (value: string) => {
    setAppLanguage(value, i18n);
  };

  // Helper to update proxyConfig and auto-save
  const updateProxyConfig = async (newProxyConfig: ProxyConfig) => {
    setProxyConfig(newProxyConfig);
    if (config) {
      await saveConfig({ ...config, proxy: newProxyConfig });
    }
  };

  if (isLoading || !proxyConfig) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="scrollbar-hide container mx-auto h-[calc(100vh-theme(spacing.16))] max-w-4xl space-y-8 overflow-y-auto p-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('settings.title')}</h2>
        <p className="text-muted-foreground mt-1">{t('settings.description')}</p>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="general">{t('settings.general', 'General')}</TabsTrigger>
          <TabsTrigger value="proxy">{t('settings.proxy_tab', 'Proxy')}</TabsTrigger>
        </TabsList>

        {/* --- GENERAL TAB --- */}
        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.appearance.title')}</CardTitle>
              <CardDescription>{t('settings.appearance.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between space-x-2">
                <div className="space-y-1">
                  <Label htmlFor="dark-mode">{t('settings.darkMode')}</Label>
                  <p className="text-muted-foreground text-sm">
                    {t('settings.darkModeDescription')}
                  </p>
                </div>
                <Switch
                  id="dark-mode"
                  checked={theme === 'dark'}
                  onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
                />
              </div>

              <div className="flex items-center justify-between space-x-2">
                <div className="space-y-1">
                  <Label htmlFor="language">{t('settings.language.title')}</Label>
                  <p className="text-muted-foreground text-sm">
                    {t('settings.language.description')}
                  </p>
                </div>
                <Select
                  value={i18n.language}
                  onValueChange={handleLanguageChange}
                  key={i18n.language}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder={t('settings.language.title')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{t('settings.language.english')}</SelectItem>
                    <SelectItem value="zh-CN">{t('settings.language.chinese')}</SelectItem>
                    <SelectItem value="ru">{t('settings.language.russian')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Account Settings Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.account.title', 'Account Settings')}</CardTitle>
              <CardDescription>
                {t('settings.account.description', 'Configure automatic account refresh and sync.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Auto Refresh Quota */}
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('settings.account.auto_refresh', 'Auto Refresh Quota')}</Label>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.account.auto_refresh_desc',
                      'Periodically refresh quota info for all accounts',
                    )}
                  </p>
                </div>
                <Switch
                  checked={config?.auto_refresh || false}
                  onCheckedChange={async (checked) => {
                    if (config) {
                      await saveConfig({ ...config, auto_refresh: checked });
                    }
                  }}
                />
              </div>

              {/* Auto Sync Account */}
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('settings.account.auto_sync', 'Auto Sync Current Account')}</Label>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.account.auto_sync_desc',
                      'Periodically sync active account information',
                    )}
                  </p>
                </div>
                <Switch
                  checked={config?.auto_sync || false}
                  onCheckedChange={async (checked) => {
                    if (config) {
                      await saveConfig({ ...config, auto_sync: checked });
                    }
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Notifications Settings Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                {t('settings.notifications.title', 'Notifications')}
              </CardTitle>
              <CardDescription>
                {t(
                  'settings.notifications.description',
                  'Configure desktop notifications for account switching and quota warnings.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Enable Notifications Toggle */}
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('settings.notifications.enabled', 'Enable Notifications')}</Label>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.notifications.enabled_desc',
                      'Show desktop notifications for important events',
                    )}
                  </p>
                </div>
                <Switch
                  checked={config?.notifications?.enabled ?? true}
                  onCheckedChange={async (checked) => {
                    if (config) {
                      await saveConfig({
                        ...config,
                        notifications: { ...config.notifications, enabled: checked },
                      });
                    }
                  }}
                />
              </div>

              {/* Warning Threshold Slider */}
              <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.notifications.warning_threshold', 'Warning Threshold')}</Label>
                    <span className="text-sm font-medium text-primary">
                      {localWarningThreshold}%
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.notifications.warning_threshold_desc',
                      'Show warning notification when quota falls below this percentage',
                    )}
                  </p>
                </div>
                <Slider
                  value={[localWarningThreshold]}
                  min={5}
                  max={50}
                  step={5}
                  disabled={!config?.notifications?.enabled}
                  onValueChange={(value) => {
                    setLocalWarningThreshold(value[0]);
                  }}
                  onValueCommit={async (value) => {
                    if (config && value[0] > localSwitchThreshold) {
                      await saveConfig({
                        ...config,
                        notifications: { ...config.notifications, quota_warning_threshold: value[0] },
                      });
                    } else {
                      // Revert to saved value and show error
                      setLocalWarningThreshold(config?.notifications?.quota_warning_threshold ?? 20);
                      toast({
                        title: t('settings.notifications.validation_error', 'Invalid Value'),
                        description: t('settings.notifications.warning_must_be_higher', 'Warning threshold must be higher than switch threshold'),
                        variant: 'destructive',
                      });
                    }
                  }}
                />
              </div>

              {/* Switch Threshold Slider */}
              <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.notifications.switch_threshold', 'Auto-Switch Threshold')}</Label>
                    <span className="text-sm font-medium text-primary">
                      {localSwitchThreshold}%
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.notifications.switch_threshold_desc',
                      'Automatically switch accounts when quota falls below this percentage',
                    )}
                  </p>
                </div>
                <Slider
                  value={[localSwitchThreshold]}
                  min={1}
                  max={20}
                  step={1}
                  disabled={!config?.notifications?.enabled}
                  onValueChange={(value) => {
                    setLocalSwitchThreshold(value[0]);
                  }}
                  onValueCommit={async (value) => {
                    if (config && value[0] < localWarningThreshold) {
                      await saveConfig({
                        ...config,
                        notifications: { ...config.notifications, quota_switch_threshold: value[0] },
                      });
                    } else {
                      // Revert to saved value and show error
                      setLocalSwitchThreshold(config?.notifications?.quota_switch_threshold ?? 5);
                      toast({
                        title: t('settings.notifications.validation_error', 'Invalid Value'),
                        description: t('settings.notifications.switch_must_be_lower', 'Switch threshold must be lower than warning threshold'),
                        variant: 'destructive',
                      });
                    }
                  }}
                />
                {localSwitchThreshold >= localWarningThreshold && (
                  <p className="text-xs text-destructive">
                    {t(
                      'settings.notifications.threshold_error',
                      'Switch threshold must be lower than warning threshold',
                    )}
                  </p>
                )}
              </div>

              {/* Test Notification Button */}
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('settings.notifications.test')}</Label>
                  <p className="text-xs text-gray-500">
                    {t('settings.notifications.test_desc')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await sendTestNotification();
                      toast({
                        title: t('settings.notifications.toast_sent'),
                        description: t('settings.notifications.test_desc'),
                      });
                    } catch (error) {
                      console.error('Failed to send test notification', error);
                      toast({
                        variant: 'destructive',
                        title: 'Error',
                        description: 'Failed to send test notification',
                      });
                    }
                  }}
                  disabled={!config?.notifications?.enabled}
                >
                  <Bell className="mr-2 h-4 w-4" />
                  {t('settings.notifications.test')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {isAutoStartSupported && (
            <Card>
              <CardHeader>
                <CardTitle>{t('settings.startup.title', 'Startup')}</CardTitle>
                <CardDescription>
                  {t(
                    'settings.startup.description',
                    'Control application launch behavior at system startup.',
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-1">
                    <Label>{t('settings.startup.auto_startup', 'Start with system')}</Label>
                    <p className="text-xs text-gray-500">
                      {t(
                        'settings.startup.auto_startup_desc',
                        'Launch at sign-in and keep the app in the system tray',
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={config?.auto_startup || false}
                    onCheckedChange={async (checked) => {
                      if (config) {
                        await saveConfig({ ...config, auto_startup: checked });
                      }
                    }}
                  />
                </div>
                {isMac && (
                  <p className="text-muted-foreground text-xs">
                    {t(
                      'settings.startup.macos_hint',
                      'macOS requires a signed app for Login Items to work. If auto-start fails, please sign the app or enable it manually in System Settings.',
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('settings.about.title')}</CardTitle>
              <CardDescription>{t('settings.about.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="text-muted-foreground">{t('settings.version')}</div>
                <div className="font-medium">{appVersion || 'Unknown'}</div>

                <div className="text-muted-foreground">{t('settings.platform')}</div>
                <div className="font-medium capitalize">{platform || 'Unknown'}</div>

                <div className="text-muted-foreground">{t('settings.license')}</div>
                <div className="font-medium">CC BY-NC-SA 4.0</div>

                <div className="text-muted-foreground">{t('action.openLogs')}</div>
                <button
                  onClick={() => openLogDirectory()}
                  className="flex items-center gap-2 font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span>{t('settings.openLogDir', 'Open')}</span>
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Privacy & Error Reporting Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.privacy.title', 'Privacy')}</CardTitle>
              <CardDescription>
                {t(
                  'settings.privacy.description',
                  'Control how your data is used to improve the application.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('settings.privacy.error_reporting', 'Error Reporting')}</Label>
                  <p className="text-xs text-gray-500">
                    {t(
                      'settings.privacy.error_reporting_desc',
                      'Send anonymous error reports to help us improve the app. No personal data is collected.',
                    )}
                  </p>
                </div>
                <Switch
                  checked={config?.error_reporting_enabled || false}
                  onCheckedChange={async (checked) => {
                    if (config) {
                      await saveConfig({ ...config, error_reporting_enabled: checked });
                    }
                  }}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                {t(
                  'settings.privacy.restart_note',
                  'Changes to error reporting will take effect after restarting the application.',
                )}
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- PROXY TAB (Upstream Proxy Config Only) --- */}
        <TabsContent value="proxy" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.proxy.title')}</CardTitle>
              <CardDescription>{t('settings.proxy.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between space-x-2">
                <div className="space-y-1">
                  <Label htmlFor="upstream-proxy-enabled">{t('settings.proxy.enable')}</Label>
                </div>
                <Switch
                  id="upstream-proxy-enabled"
                  checked={proxyConfig.upstream_proxy.enabled}
                  onCheckedChange={(checked) =>
                    updateProxyConfig({
                      ...proxyConfig,
                      upstream_proxy: { ...proxyConfig.upstream_proxy, enabled: checked },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upstream-proxy-url">{t('settings.proxy.url')}</Label>
                <Input
                  id="upstream-proxy-url"
                  placeholder="http://127.0.0.1:7890"
                  value={proxyConfig.upstream_proxy.url}
                  onChange={(e) =>
                    updateProxyConfig({
                      ...proxyConfig,
                      upstream_proxy: { ...proxyConfig.upstream_proxy, url: e.target.value },
                    })
                  }
                  disabled={!proxyConfig.upstream_proxy.enabled}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});
