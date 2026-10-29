import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { WorkspaceProfileView } from '@/modules/workspace/types';

export interface DeleteWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceProfileView | null;
  onConfirm: (id: string, cleanUserDataDir: boolean) => Promise<void>;
  isDeleting?: boolean;
}

export const DeleteWorkspaceDialog: React.FC<DeleteWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  workspace,
  onConfirm,
  isDeleting = false,
}) => {
  const { t } = useTranslation();
  const [cleanUserDataDir, setCleanUserDataDir] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isRunning = workspace?.status.running ?? false;

  const handleConfirm = async () => {
    if (!workspace) {
      return;
    }
    setError(null);
    try {
      await onConfirm(workspace.id, cleanUserDataDir);
      onOpenChange(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t('workspace-profile.failed-to-delete-workspace'),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">
            {t('workspace-profile.delete-workspace-profile')}
          </DialogTitle>
          <DialogDescription>
            {t('workspace-profile.delete-confirm', { name: workspace?.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {isRunning && (
            <div
              className="border-destructive/20 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-3"
              data-testid="running-workspace-warning"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                {t(
                  'workspace-profile.warning-this-workspace-is-currently-running-please-stop-the-ide-before-deleting-it',
                )}
              </span>
            </div>
          )}

          <div className="flex items-center space-x-2">
            <Checkbox
              id="clean-dir"
              checked={cleanUserDataDir}
              onCheckedChange={(checked) => setCleanUserDataDir(Boolean(checked))}
            />
            <label
              htmlFor="clean-dir"
              className="cursor-pointer text-xs leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              {t('workspace-profile.remove-profile-data')}
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            {t('workspace-profile.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isDeleting || isRunning}>
            {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('workspace-profile.delete-workspace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
