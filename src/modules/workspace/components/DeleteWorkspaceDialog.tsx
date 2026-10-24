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
  const [cleanUserDataDir, setCleanUserDataDir] = useState(true);
  const isRunning = workspace?.status.running ?? false;

  const handleConfirm = async () => {
    if (!workspace) return;
    await onConfirm(workspace.id, cleanUserDataDir);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete Workspace Profile</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete workspace profile &ldquo;{workspace?.name}&rdquo;?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          {isRunning && (
            <div
              className="border-destructive/20 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-3"
              data-testid="running-workspace-warning"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                Warning: This workspace is currently running. Please stop the IDE before deleting
                it.
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
              Permanently remove isolated profile data folder (`userDataDir`)
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isDeleting || isRunning}>
            {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
