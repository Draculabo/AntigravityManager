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
      setError(err instanceof Error ? err.message : 'Failed to select directory');
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedPath = projectPath.trim();

    if (!trimmedName) {
      setError('Workspace profile name is required.');
      return;
    }
    if (trimmedName.length > 100) {
      setError('Workspace profile name cannot exceed 100 characters.');
      return;
    }
    if (!accountId) {
      setError('A bound Google account must be selected.');
      return;
    }
    if (!trimmedPath) {
      setError('Project directory path is required.');
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
      setError(err instanceof Error ? err.message : 'Failed to save workspace profile');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Workspace Profile' : 'Create New Workspace'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the workspace profile details, bound Google account, or project folder.'
              : 'Configure an isolated Antigravity IDE workspace session with its own Google account and project folder.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 py-2">
          {error && (
            <div className="border-destructive/20 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-3 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Profile Name Field */}
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">Profile Name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Client Portal, Personal Research"
              maxLength={100}
              required
            />
          </div>

          {/* Bound Google Account Dropdown */}
          <div className="space-y-1.5">
            <Label htmlFor="ws-account">Bound Google Account</Label>
            {accounts.length === 0 ? (
              <div className="border-warning-border bg-warning-soft/30 text-warning rounded-lg border p-3 text-xs">
                No Google accounts found in Antigravity Manager. Please add an account on the
                Accounts page before creating a workspace.
              </div>
            ) : (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="ws-account" className="h-11 w-full">
                  <SelectValue placeholder="Select Google Account" />
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
            <Label htmlFor="ws-path">Project Directory</Label>
            <div className="flex gap-2">
              <Input
                id="ws-path"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="/path/to/project/folder"
                className="flex-1 font-mono text-xs"
                required
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowseFolder}
                disabled={isBrowsing}
                aria-label="Browse for project folder"
                title="Browse folder"
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
                Isolated User Data Directory
              </span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
                Auto-Managed
              </Badge>
            </div>
            <p className="text-foreground/80 bg-background/80 border-border/50 rounded border px-2.5 py-1.5 font-mono text-[11px] break-all">
              {isEdit && activeProfile
                ? activeProfile.userDataDir
                : '~/.config/AntigravityManager/profiles/<auto-generated-id>'}
            </p>
            <p className="text-muted-foreground text-[11px]">
              A dedicated profile directory housing isolated OAuth credentials (`state.vscdb`) and
              session tokens.
            </p>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || accounts.length === 0}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? 'Save Changes' : 'Create Workspace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
