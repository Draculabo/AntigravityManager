import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';

export function useAuditDropReset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ipc.client.gateway.auditResetDropStats({ trafficClass: null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gateway'] }),
  });
}
