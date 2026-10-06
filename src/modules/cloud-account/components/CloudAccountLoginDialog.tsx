import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import {
  useStartGoogleAuthFlow,
  useSubmitGoogleAuthCode,
  useOAuthClients,
  useSetActiveOAuthClient,
} from '../hooks/useCloudAccounts';
import { readDesktopOAuthLoginErrorCode } from '../services/desktop-oauth-login.schema';
import { CloudAccountAuthDialog } from './CloudAccountAuthDialog';

export function CloudAccountLoginDialog() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const loginMutation = useStartGoogleAuthFlow();
  const submitCodeMutation = useSubmitGoogleAuthCode();
  const { data: oauthClients = [], isLoading: isOAuthClientsLoading } = useOAuthClients();
  const setActiveOAuthClientMutation = useSetActiveOAuthClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [overrideOAuthClientKey, setSelectedOAuthClientKey] = useState<string | null>(null);
  const selectedOAuthClientKey =
    overrideOAuthClientKey ?? oauthClients.find((client) => client.is_active)?.key ?? '';

  const openGoogleAuthSignIn = () => {
    setAuthCode('');
    const effectiveClientKey =
      selectedOAuthClientKey || oauthClients.find((client) => client.is_active)?.key;
    loginMutation.mutate(effectiveClientKey ? { oauthClientKey: effectiveClientKey } : undefined, {
      onSuccess: () => {
        setIsAddDialogOpen(false);
        setAuthCode('');
        toast({ title: t('cloud.toast.addSuccess'), variant: 'success' });
      },
      onError: (error) => {
        const loginCode = readDesktopOAuthLoginErrorCode(error) ?? 'login-failed';
        toast({
          title: t('cloud.toast.addFailed.title'),
          description: t(`cloud.toast.addFailed.codes.${loginCode}`),
          variant: 'destructive',
        });
      },
    });
  };

  const submitManualAuthCode = () => {
    const code = authCode.trim();
    if (!code || !loginMutation.isPending) {
      return;
    }
    submitCodeMutation.mutate(
      { code },
      {
        onSuccess: () => setAuthCode(''),
        onError: (error) => {
          const loginCode = readDesktopOAuthLoginErrorCode(error) ?? 'login-failed';
          toast({
            title: t('cloud.toast.addFailed.title'),
            description: t(`cloud.toast.addFailed.codes.${loginCode}`),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) {
      setAuthCode('');
    }
  };

  const handleOAuthClientChange = (value: string) => {
    setSelectedOAuthClientKey(value);
    setActiveOAuthClientMutation.mutate(
      {
        clientKey: value,
      },
      {
        onError: (error) => {
          toast({
            title: t('cloud.toast.updateSettingsFailed'),
            description: getLocalizedErrorMessage(error, t),
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <CloudAccountAuthDialog
      open={isAddDialogOpen}
      onOpenChange={handleAddDialogOpenChange}
      selectedOAuthClientKey={selectedOAuthClientKey}
      oauthClients={oauthClients}
      isOAuthClientsLoading={isOAuthClientsLoading}
      isSetActiveOAuthClientPending={setActiveOAuthClientMutation.isPending}
      isAddPending={loginMutation.isPending}
      isCodeSubmitting={submitCodeMutation.isPending}
      authCode={authCode}
      onOAuthClientChange={handleOAuthClientChange}
      onOpenGoogleAuthSignIn={openGoogleAuthSignIn}
      onAuthCodeChange={setAuthCode}
      onSubmitAuthCode={submitManualAuthCode}
    />
  );
}
