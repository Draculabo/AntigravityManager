import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '@/modules/cloud-account/hooks/useCloudAccounts';
import {
  confirmLocalAccountImport,
  discardLocalAccountImport,
  previewLocalAccountImport,
} from '../actions';

export function useLocalAccountImport() {
  const queryClient = useQueryClient();
  const preview = useMutation({
    mutationFn: previewLocalAccountImport,
  });
  const confirm = useMutation({
    mutationFn: confirmLocalAccountImport,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
  const discard = useMutation({
    mutationFn: discardLocalAccountImport,
  });

  return {
    preview,
    confirm,
    discard,
  };
}
