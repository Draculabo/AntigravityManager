import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';
import {
  Play,
  Square,
  MoreVertical,
  Pencil,
  Trash2,
  Folder,
  Copy,
  Check,
  Shield,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AccountTierBadge } from '@/modules/cloud-account/components/AccountTierBadge';
import { useToast } from '@/components/ui/use-toast';
import type { WorkspaceProfileView } from '@/modules/workspace/types';

export interface WorkspaceCardProps {
  workspace: WorkspaceProfileView;
  onLaunch: (id: string) => void | Promise<void>;
  onStop: (id: string) => void | Promise<void>;
  onEdit: (workspace: WorkspaceProfileView) => void;
  onDelete: (workspace: WorkspaceProfileView) => void;
  isLaunching?: boolean;
  isStopping?: boolean;
  toast?: (options: {
    title: string;
    description?: string;
    variant?: 'default' | 'destructive';
  }) => void;
}

export const WorkspaceCard: React.FC<WorkspaceCardProps> = ({
  workspace,
  onLaunch,
  onStop,
  onEdit,
  onDelete,
  isLaunching = false,
  isStopping = false,
  toast: customToast,
}) => {
  const { t } = useTranslation();
  const { toast: defaultToast } = useToast();
  const toast = customToast ?? defaultToast;
  const [copied, setCopied] = useState(false);
  const isRunning = workspace.status.running;
  const account = workspace.account;

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(workspace.projectPath);
      setCopied(true);
      toast({
        title: t('workspace-profile.path-copied'),
        description: t('workspace-profile.project-folder-path-copied-to-clipboard'),
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: t('workspace-profile.failed-to-copy'), variant: 'destructive' });
    }
  };

  const formatLastLaunched = (timestamp?: number | null) => {
    if (!timestamp) {
      return t('workspace-profile.never-launched');
    }
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Card className="group bg-card text-card-foreground hover:border-primary/30 relative flex flex-col justify-between overflow-hidden rounded-xl border shadow-sm transition-all duration-200 hover:shadow-md">
      {/* Top Header */}
      <CardHeader className="bg-muted/10 flex flex-row items-start justify-between gap-3 space-y-0 border-b p-4">
        <div className="min-w-0 flex-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <CardTitle className="text-foreground truncate">{workspace.name}</CardTitle>
              </TooltipTrigger>
              <TooltipContent>{workspace.name}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[11px]">
            <span>
              {t('workspace-profile.last-active', {
                time: formatLastLaunched(workspace.lastLaunchedAt),
              })}
            </span>
          </div>
        </div>

        {/* Live Status Badge */}
        <div className="shrink-0" data-testid={`workspace-status-${workspace.id}`}>
          {workspace.status.unknown ? (
            <span className="text-muted-foreground text-xs" role="status">
              {t('workspace-profile.status-unavailable')}
            </span>
          ) : isRunning ? (
            <span
              className="border-success-border bg-success-soft text-success inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
              title={t('workspace-profile.running-pid', { pid: workspace.status.pid })}
            >
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
                <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
              </span>
              <span>
                {t('workspace-profile.running')}
                {workspace.status.pid ? ` (PID: ${workspace.status.pid})` : ''}
              </span>
            </span>
          ) : (
            <span
              className="border-border bg-muted/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
              title={t('workspace-profile.workspace-process-is-stopped')}
            >
              <span className="bg-muted-foreground/40 h-2 w-2 rounded-full" aria-hidden="true" />
              <span>{t('workspace-profile.idle')}</span>
            </span>
          )}
        </div>
      </CardHeader>

      {/* Main Body */}
      <CardContent className="space-y-3.5 p-4">
        {/* Bound Google Account Display */}
        <div className="bg-muted/20 rounded-lg border p-2.5" data-testid="bound-account-section">
          <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">
            {t('workspace-profile.bound-google-account')}
          </div>
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar className="border-border h-8 w-8 shrink-0 rounded-full border">
                {account?.avatar_url && (
                  <AvatarImage src={account.avatar_url} alt={account.name || account.email} />
                )}
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
                  {account?.name
                    ? account.name[0].toUpperCase()
                    : account?.email
                      ? account.email[0].toUpperCase()
                      : 'G'}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="text-foreground truncate text-xs font-medium">
                  {account?.email ?? workspace.accountId}
                </div>
                {account?.name && (
                  <div className="text-muted-foreground truncate text-[10px]">{account.name}</div>
                )}
              </div>
            </div>

            {account ? (
              <AccountTierBadge
                account={account}
                unknownLabel={t('workspace-profile.standard')}
                className="shrink-0"
              />
            ) : (
              <Badge
                variant="outline"
                className="border-warning-border bg-warning-soft text-warning shrink-0 text-[10px]"
              >
                {t('workspace-profile.unbound')}
              </Badge>
            )}
          </div>
        </div>

        {/* Project Folder Display */}
        <div className="space-y-1">
          <div className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
            {t('workspace-profile.project-folder')}
          </div>
          <div className="bg-muted/10 flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-muted-foreground hover:text-foreground flex min-w-0 cursor-pointer items-center gap-2 transition-colors">
                    <Folder className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono text-xs">{workspace.projectPath}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-md font-mono text-xs break-all">
                  {workspace.projectPath}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
              onClick={handleCopyPath}
              aria-label={t('workspace-profile.copy-project-folder-path')}
              title={t('workspace-profile.copy-path')}
            >
              {copied ? (
                <Check className="text-success h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {/* User Data Directory Info Banner */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-muted-foreground/80 flex cursor-help items-center gap-1.5 text-[11px]">
                <Shield className="text-muted-foreground/70 h-3.5 w-3.5" />
                <span className="truncate">
                  {t('workspace-profile.isolated-profile-data')}
                  <span className="font-mono">{workspace.userDataDir}</span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-md font-mono text-xs break-all">
              {t('workspace-profile.user-data-dir')}
              {workspace.userDataDir}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </CardContent>

      {/* Footer Actions */}
      <CardFooter className="bg-muted/10 flex items-center justify-between border-t p-3">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button
              size="sm"
              variant="outline"
              className="border-success-border bg-success-soft text-success hover:bg-success-soft/80 h-8 gap-1.5 text-xs font-semibold"
              onClick={() => onLaunch(workspace.id)}
              disabled
            >
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              {t('workspace-profile.already-running')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs font-semibold"
              onClick={() => onLaunch(workspace.id)}
              disabled={isLaunching}
            >
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              {t('workspace-profile.launch-ide')}
            </Button>
          )}

          {isRunning && (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 h-8 gap-1.5 text-xs font-semibold"
              onClick={() => onStop(workspace.id)}
              disabled={isStopping}
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              {t('workspace-profile.stop')}
            </Button>
          )}
        </div>

        {/* Overflow Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-8 w-8"
            >
              <MoreVertical className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t('workspace-profile.more-actions')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onEdit(workspace)} className="cursor-pointer">
              <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workspace-profile.edit-profile')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyPath} className="cursor-pointer">
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workspace-profile.copy-path-label')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(workspace)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer"
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workspace-profile.delete-workspace')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardFooter>
    </Card>
  );
};
