import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentToolSyncCard } from './AgentToolSyncCard';
import { ClientConfigSyncCard } from './ClientConfigSyncCard';
import { ConnectionProfilesCard, useConnectionProfiles } from './ConnectionProfilesCard';
import { DshSyncCard } from './DshSyncCard';
import { OpenCodeSyncCard } from './OpenCodeSyncCard';
import { ProfileToolSetup, type ProfileTool } from './ProfileToolSetup';
import { gatewayToolNames } from './gateway-tool-defaults';
import type { ProxyExampleModel } from './proxy-example-models';

const profileTools: readonly ProfileTool[] = ['kimi-code', 'qwen-code', 'gemini-cli', 'pi'];
type NativeTool = Exclude<keyof typeof gatewayToolNames, ProfileTool>;

export function GatewayTools({
  baseUrl,
  models,
  quickModels,
  hasGatewayKey,
}: {
  baseUrl: string;
  models: readonly ProxyExampleModel[];
  quickModels: readonly string[];
  hasGatewayKey: boolean;
}) {
  const { t } = useTranslation();
  const profiles = useConnectionProfiles();
  const sharedKeyModels = hasGatewayKey ? quickModels : [];
  const manage = (client: NativeTool) => {
    const singleActive = client === 'claude' || client === 'codex' || client === 'hermes';
    const applied =
      profiles.data?.filter((profile) => profile.client === client && profile.applied) ?? [];
    return {
      profileApplied: applied.length > 0,
      nativeSetupBlocked: singleActive && (!profiles.isSuccess || applied.length > 0),
      nativeRestoreBlocked: (singleActive || client === 'opencode') && applied.length > 0,
      blocksNativeActivation: (profile?: string) =>
        !profiles.isSuccess ||
        applied.some(
          (item) =>
            item.activateModel !== null && (client !== 'dsh' || item.dshProfile === profile),
        ),
      profiles: (nativeConfigured: boolean, onBusyChange: (busy: boolean) => void) => (
        <ConnectionProfilesCard
          client={client}
          baseUrl={baseUrl}
          models={models}
          nativeConfigured={singleActive && nativeConfigured}
          onBusyChange={onBusyChange}
        />
      ),
    };
  };

  return (
    <Card className="gap-0 shadow-none">
      <CardHeader className="border-b p-4">
        <CardTitle>{t('client-config.tools-title')}</CardTitle>
        <p className="text-muted-foreground text-xs">
          {quickModels[0]
            ? t('client-config.quick-model', { model: quickModels[0] })
            : t('client-config.quick-no-models')}
        </p>
        {!hasGatewayKey && (
          <a
            className="text-primary w-fit text-sm underline-offset-4 hover:underline"
            href="#gateway-api-key"
          >
            {t('client-config.config-key-missing')}
          </a>
        )}
      </CardHeader>
      <CardContent className="divide-border divide-y p-0">
        <AgentToolSyncCard
          tool="claude"
          baseUrl={baseUrl}
          models={models}
          quickModel={sharedKeyModels[0]}
          management={manage('claude')}
        />
        <AgentToolSyncCard
          tool="codex"
          baseUrl={baseUrl}
          models={models}
          quickModel={sharedKeyModels[0]}
          management={manage('codex')}
        />
        <OpenCodeSyncCard
          baseUrl={baseUrl}
          models={models}
          quickModels={quickModels}
          management={manage('opencode')}
        />
        <ClientConfigSyncCard
          client="hermes"
          baseUrl={baseUrl}
          quickModels={sharedKeyModels}
          management={manage('hermes')}
        />
        <ClientConfigSyncCard
          client="openclaw"
          baseUrl={baseUrl}
          quickModels={sharedKeyModels}
          management={manage('openclaw')}
        />
        <DshSyncCard baseUrl={baseUrl} quickModels={sharedKeyModels} management={manage('dsh')} />
        {profileTools.map((client) => (
          <ProfileToolSetup
            key={client}
            client={client}
            baseUrl={baseUrl}
            models={models}
            quickModels={sharedKeyModels}
          />
        ))}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm">
        <p className="text-muted-foreground">{t('client-config.verify-in-traffic')}</p>
        <Link
          className="text-primary underline-offset-4 hover:underline"
          to="/traffic"
          search={{ page: 0, search: '', tab: 'model' }}
        >
          {t('client-config.open-traffic')}
        </Link>
      </div>
    </Card>
  );
}
