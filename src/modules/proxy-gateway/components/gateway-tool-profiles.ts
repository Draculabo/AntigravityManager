import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import type { ConnectionProfileView } from '../connection-profiles/connection-profiles.schema';
import { gatewayToolOptions } from './gateway-tool-defaults';

export function useGatewayToolProfiles() {
  return useQuery({
    queryKey: ['gateway', 'connectionProfiles'],
    queryFn: () => ipc.client.gateway.connectionProfiles.list({}),
    retry: false,
  });
}

export async function applyToolProfile(id: string, action: 'apply' | 'remove') {
  const preview = await ipc.client.gateway.connectionProfiles.preview({ id, action });
  await ipc.client.gateway.connectionProfiles.mutate({
    id,
    action,
    expectedSourceHash: preview.sourceHash,
  });
}

export async function connectToolProfile(
  tool: ConnectionProfileView['client'],
  baseUrl: string,
  model: string,
  models: readonly string[],
  profiles: readonly ConnectionProfileView[],
) {
  const defaults = gatewayToolOptions(tool);
  const name = `Local gateway (${new URL(baseUrl).host})`;
  const saved = profiles.find((profile) => profile.name === name && profile.baseUrl === baseUrl);
  const connection = await ipc.client.gateway.connectionProfiles.save({
    ...defaults,
    ...(saved && { id: saved.id, expectedRevision: saved.revision }),
    name,
    baseUrl,
    models: models.slice(0, 256),
    activateModel: model,
    credentialSource: 'manager-default',
  });
  await applyToolProfile(connection.id, 'apply');
}
