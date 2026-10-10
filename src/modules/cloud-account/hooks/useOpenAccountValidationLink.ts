import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { openAccountValidationLink } from '@/modules/cloud-account/actions/cloud';
import { readAccountValidationLinkErrorCode } from '@/modules/cloud-account/services/account-validation-link.schema';

export function useOpenAccountValidationLink() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isPending, setPending] = useState(false);

  const open = async (accountId: string): Promise<void> => {
    if (isPending) {
      return;
    }
    setPending(true);
    try {
      await openAccountValidationLink({ accountId });
    } catch (error) {
      const validationCode = readAccountValidationLinkErrorCode(error) ?? 'validation-link-failed';
      toast({
        error,
        title: t('cloud.toast.validationLinkFailed.title'),
        description: t(`cloud.toast.validationLinkFailed.codes.${validationCode}`),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  };

  return { open, isPending };
}
