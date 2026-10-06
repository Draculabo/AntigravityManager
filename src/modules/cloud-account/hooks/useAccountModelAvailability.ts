import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';

type ModelAvailabilityList = Awaited<ReturnType<typeof ipc.client.gateway.modelAvailability>>;
const EMPTY_AVAILABILITY: ModelAvailabilityList = [];

export function useAccountModelAvailability(accountId: string) {
  const selectAccount = useCallback(
    (entries: ModelAvailabilityList) => entries.filter((entry) => entry.accountId === accountId),
    [accountId],
  );
  const { data } = useQuery({
    queryKey: ['gateway', 'modelAvailability'],
    queryFn: () => ipc.client.gateway.modelAvailability(),
    refetchInterval: 15_000,
    select: selectAccount,
  });
  return data ?? EMPTY_AVAILABILITY;
}
