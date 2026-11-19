import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { ConnectionProfilesCard, useConnectionProfiles } from './ConnectionProfilesCard';
import { NativeClientSetupCard } from './NativeClientSetupCard';
import { gatewayToolNames, gatewayToolOptions } from './gateway-tool-defaults';
import { readClientConfigFailure } from './client-config-failure';
import type { ProxyExampleModel } from './proxy-example-models';

export type ProfileTool = 'kimi-code' | 'qwen-code' | 'gemini-cli' | 'pi';

export function ProfileToolSetup({
  client,
  baseUrl,
  models,
  quickModels,
}: {
  client: ProfileTool;
  baseUrl: string;
  models: readonly ProxyExampleModel[];
  quickModels: readonly string[];
}) {
  const { t } = useTranslation();
  const profiles = useConnectionProfiles();
  const saved = profiles.data?.filter((profile) => profile.client === client) ?? [];
  const profileApplied = saved.some((profile) => profile.applied);
  const name = gatewayToolNames[client];
  const savedDefault = saved.find(
    (profile) =>
      profile.name === name && profile.baseUrl === baseUrl && profile.credentialConfigured,
  );
  const setup = useMutation({
    mutationFn: async (defaultModel: string) => {
      const profile =
        savedDefault ??
        (await ipc.client.gateway.connectionProfiles.save({
          ...gatewayToolOptions(client),
          name,
          baseUrl,
          models: quickModels.slice(0, 256),
          activateModel: defaultModel,
          credentialSource: 'manager-default',
        }));
      const preview = await ipc.client.gateway.connectionProfiles.preview({
        id: profile.id,
        action: 'apply',
      });
      return ipc.client.gateway.connectionProfiles.mutate({
        id: profile.id,
        action: 'apply',
        expectedSourceHash: preview.sourceHash,
      });
    },
    onSettled: async () => {
      await profiles.refetch();
    },
  });

  return (
    <NativeClientSetupCard
      name={name}
      defaultModel={savedDefault?.activateModel ?? quickModels[0]}
      ready={profiles.isSuccess && (!saved.length || Boolean(savedDefault))}
      configureLabel={savedDefault ? t('client-config.apply-saved') : undefined}
      busy={setup.isPending}
      configured={profileApplied}
      status={
        profiles.isPending
          ? t('agent-tools.loading')
          : saved.length
            ? t('client-config.connection-saved')
            : undefined
      }
      management={{
        profileApplied,
        profiles: (_nativeConfigured, onBusyChange) => (
          <ConnectionProfilesCard
            client={client}
            baseUrl={baseUrl}
            models={models}
            onBusyChange={onBusyChange}
          />
        ),
      }}
      onConfigure={() => {
        const model = savedDefault?.activateModel ?? quickModels[0];
        if (model && !setup.isPending && profiles.isSuccess && (!saved.length || savedDefault)) {
          setup.mutate(model);
        }
      }}
      feedback={
        setup.isError ? (
          <p role="alert" className="text-sm">
            {t('client-config.' + readClientConfigFailure(setup.error))}
          </p>
        ) : setup.isSuccess ? (
          <p role="status" className="text-sm">
            {t('client-config.saved-client', { name })}
          </p>
        ) : null
      }
    />
  );
}
