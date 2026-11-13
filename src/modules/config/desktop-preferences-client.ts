import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import type { DesktopPreferencesUpdate } from './service-config.schema';

export const desktopPreferencesQuery = queryOptions({
  queryKey: ['desktopPreferences'],
  queryFn: () => ipc.client.config.desktop.load(),
});

export async function saveDesktopPreferences(client: QueryClient, patch: DesktopPreferencesUpdate) {
  await client.cancelQueries({ queryKey: desktopPreferencesQuery.queryKey, exact: true });
  const saved = await ipc.client.config.desktop.save(patch);
  client.setQueryData(desktopPreferencesQuery.queryKey, saved);
  return saved;
}
