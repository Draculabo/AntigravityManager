import { Cloud, Loader2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OAuthClientDescriptor } from '@/modules/cloud-account/services/oauth-client-preference.schema';

interface CloudAccountAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedOAuthClientKey: string;
  oauthClients: OAuthClientDescriptor[];
  isOAuthClientsLoading: boolean;
  isSetActiveOAuthClientPending: boolean;
  isAddPending: boolean;
  isCodeSubmitting: boolean;
  authCode: string;
  onOAuthClientChange: (clientKey: string) => void;
  onOpenGoogleAuthSignIn: () => void;
  onAuthCodeChange: (code: string) => void;
  onSubmitAuthCode: () => void;
}

export function CloudAccountAuthDialog({
  open,
  onOpenChange,
  selectedOAuthClientKey,
  oauthClients,
  isOAuthClientsLoading,
  isSetActiveOAuthClientPending,
  isAddPending,
  isCodeSubmitting,
  authCode,
  onOAuthClientChange,
  onOpenGoogleAuthSignIn,
  onAuthCodeChange,
  onSubmitAuthCode,
}: CloudAccountAuthDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="cursor-pointer">
          <Plus className="mr-2 h-4 w-4" />
          {t('cloud.addAccount')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('cloud.authDialog.title')}</DialogTitle>
          <DialogDescription>{t('cloud.authDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="oauth-client-select">{t('cloud.authDialog.oauthClient')}</Label>
            <Select
              value={selectedOAuthClientKey || undefined}
              onValueChange={onOAuthClientChange}
              disabled={isOAuthClientsLoading || isSetActiveOAuthClientPending}
            >
              <SelectTrigger id="oauth-client-select">
                <SelectValue placeholder={t('cloud.authDialog.oauthClientPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {oauthClients.map((client) => (
                  <SelectItem key={client.key} value={client.key}>
                    {client.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            onClick={onOpenGoogleAuthSignIn}
            disabled={isAddPending || isOAuthClientsLoading || isSetActiveOAuthClientPending}
          >
            {isAddPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Cloud className="mr-2 h-4 w-4" />
            {t('cloud.authDialog.openLogin')}
          </Button>
          <div className="space-y-2">
            <Label htmlFor="code">{t('cloud.authDialog.authCode')}</Label>
            <Input
              id="code"
              autoComplete="off"
              maxLength={2048}
              placeholder={t('cloud.authDialog.placeholder')}
              value={authCode}
              onChange={(event) => onAuthCodeChange(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">{t('cloud.authDialog.instruction')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={onSubmitAuthCode}
            disabled={!isAddPending || isCodeSubmitting || !authCode.trim()}
          >
            {isCodeSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('cloud.authDialog.verify')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
