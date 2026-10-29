import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';
import { FolderOpen, Loader2, Shield, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { selectWorkspaceDirectory } from '@/modules/workspace/actions/workspace';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type {
  CreateWorkspaceProfileInput,
  UpdateWorkspaceProfileInput,
  WorkspaceProfileView,
} from '@/modules/workspace/types';

export interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace?: WorkspaceProfileView | null;
  initialData?: WorkspaceProfileView | null;
  accounts: CloudAccountView[];
  onSubmit: (data: CreateWorkspaceProfileInput | UpdateWorkspaceProfileInput) => Promise<void>;
  isSubmitting?: boolean;
  onSelectDirectory?: (defaultPath?: string) => Promise<string | null>;
}

export const WorkspaceDialog: React.FC<WorkspaceDialogProps> = ({
  open,
  onOpenChange,
  workspace,
  initialData,
  accounts,
  onSubmit,
  isSubmitting = false,
  onSelectDirectory = selectWorkspaceDirectory,
}) => {
  const { t } = useTranslation();
  const activeProfile = workspace ?? initialData ?? null;
  const isEdit = Boolean(activeProfile);

  const [name, setName] = useState(activeProfile?.name ?? '');
  const [accountId, setAccountId] = useState(activeProfile?.accountId ?? accounts[0]?.id ?? '');
  const [projectPath, setProjectPath] = useState(activeProfile?.projectPath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevProfileId, setPrevProfileId] = useState(activeProfile?.id);

  if (open !== prevOpen || activeProfile?.id !== prevProfileId) {
    setPrevOpen(open);
    setPrevProfileId(activeProfile?.id);
    if (open) {
      if (activeProfile) {
        setName(activeProfile.name);
        setAccountId(activeProfile.accountId);
        setProjectPath(activeProfile.projectPath);
      } else {
        setName('');
        setAccountId(accounts[0]?.id ?? '');
        setProjectPath('');
      }
      setError(null);
    }
  }

  const handleBrowseFolder = async () => {
    setIsBrowsing(true);
    try {
      const selected = await onSelectDirectory(projectPath || undefined);
      if (selected) {
        setProjectPath(selected);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('workspace-profile.failed-to-select-directory'),
      );
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = projectPath.trim();

    if (!trimmedName) {
      setError(t('workspace-profile.workspace-profile-name-is-required'));
      return;
    }
    if (trimmedName.length > 100) {
      setError(t('workspace-profile.workspace-profile-name-cannot-exceed-100-characters'));
      return;
    }
    if (!accountId) {
      setError(t('workspace-profile.a-bound-google-account-must-be-selected'));
      return;
    }
    if (!trimmedPath) {
      setError(t('workspace-profile.project-directory-path-is-required'));
      return;
    }

    try {
      if (isEdit && activeProfile) {
        await onSubmit({
          id: activeProfile.id,
          name: trimmedName,
          accountId,
          projectPath: trimmedPath,
        });
      } else {
        await onSubmit({
          name: trimmedName,
          accountId,
          projectPath: trimmedPath,
        });
      }
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('workspace-profile.failed-to-save-workspace-profile'),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('workspace-profile.edit-workspace-profile')
              : t('workspace-profile.create-new-workspace')}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('workspace-profile.edit-description')
              : t('workspace-profile.create-description')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 py-2">
          {activeProfile?.status.running && (
            <p className="text-muted-foreground text-sm" role="status">
              {t('workspace-profile.restart-warning')}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="border-destructive/20 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-3 text-xs"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Profile Name Field */}
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">{t('workspace-profile.profile-name')}</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workspace-profile.e-g-acme-client-portal-personal-research')}
              maxLength={100}
              required
            />
          </div>

          {/* Bound Google Account Dropdown */}
          <div className="space-y-1.5">
            <Label htmlFor="ws-account">{t('workspace-profile.bound-google-account')}</Label>
            {accounts.length === 0 ? (
              <div className="border-warning-border bg-warning-soft/30 text-warning rounded-lg border p-3 text-xs">
                {t('workspace-profile.no-accounts')}
              </div>
            ) : (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="ws-account" className="h-11 w-full">
                  <SelectValue placeholder={t('workspace-profile.select-google-account')} />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id} className="cursor-pointer py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-6 w-6 shrink-0 rounded-full border">
                          {acc.avatar_url && <AvatarImage src={acc.avatar_url} />}
                          <AvatarFallback className="text-[10px] font-bold">
                            {acc.email[0].toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-foreground truncate text-xs font-medium">
                          {acc.email}
                        </span>
                        {acc.quota?.subscription_tier && (
                          <Badge variant="outline" className="ml-auto h-4 px-1 py-0 text-[10px]">
                            {acc.quota.subscription_tier}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Project Directory with Folder Browse Button */}
          <div className="space-y-1.5">
            <Label htmlFor="ws-path">{t('workspace-profile.project-directory')}</Label>
            <div className="flex gap-2">
              <Input
                id="ws-path"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder={t('workspace-profile.path-to-project-folder')}
                className="flex-1 font-mono text-xs"
                required
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowseFolder}
                disabled={isBrowsing}
                aria-label={t('workspace-profile.browse-for-project-folder')}
                title={t('workspace-profile.browse-folder')}
              >
                {isBrowsing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Auto-Generated User Data Directory Preview */}
          <div className="bg-muted/40 space-y-1.5 rounded-lg border p-3 text-xs">
            <div className="text-muted-foreground flex items-center justify-between font-medium">
              <span className="flex items-center gap-1.5">
                <Shield className="text-primary h-3.5 w-3.5" />
                {t('workspace-profile.isolated-user-data-directory')}
              </span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
                {t('workspace-profile.auto-managed')}
              </Badge>
            </div>
            <p className="text-foreground/80 bg-background/80 border-border/50 rounded border px-2.5 py-1.5 font-mono text-[11px] break-all">
              {isEdit && activeProfile
                ? activeProfile.userDataDir
                : t('workspace-profile.created-automatically-when-saved')}
            </p>
            <p className="text-muted-foreground text-[11px]">
              {t('workspace-profile.login-data-description')}
            </p>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('workspace-profile.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting || accounts.length === 0}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit
                ? t('workspace-profile.save-changes')
                : t('workspace-profile.create-workspace')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
