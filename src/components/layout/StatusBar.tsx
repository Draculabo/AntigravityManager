import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isProcessRunning,
  startAntigravity,
  closeAntigravity,
} from '@/modules/antigravity-runtime/actions/process';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/ui/utils';
import { Activity, ChevronUp, Code2, Loader2, Play, Power, Square, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface StatusBarProps {
  isCollapsed?: boolean;
}

interface ServiceStatus {
  target: AntigravityAppTarget;
  label: string;
  icon: React.ElementType;
  isRunning: boolean;
  isLoading: boolean;
  isPending: boolean;
  toggle: () => void;
}

function useServiceStatus(target: AntigravityAppTarget) {
  const queryClient = useQueryClient();

  const { data: isRunning, isLoading } = useQuery({
    queryKey: ['process', 'status', target],
    queryFn: () => isProcessRunning(target),
    refetchInterval: 10000,
  });

  const startMutation = useMutation({
    mutationFn: () => startAntigravity(target),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['process', 'status', target] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => closeAntigravity(target),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['process', 'status', target] });
    },
  });

  const toggle = () => {
    if (isRunning) {
      stopMutation.mutate();
    } else {
      startMutation.mutate();
    }
  };

  return {
    isRunning: Boolean(isRunning),
    isLoading,
    isPending: startMutation.isPending || stopMutation.isPending,
    toggle,
  };
}

function ServiceRow({ service }: { service: ServiceStatus }) {
  const { t } = useTranslation();
  const Icon = service.icon;
  const isBusy = service.isLoading || service.isPending;

  return (
    <div className="hover:bg-accent/60 flex min-h-12 items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            service.isRunning
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{service.label}</div>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
            {service.isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  service.isRunning ? 'bg-green-500' : 'bg-red-500',
                )}
              />
            )}
            <span>
              {service.isLoading
                ? t('status.checking_short')
                : service.isRunning
                  ? t('status.running_short')
                  : t('status.stopped_short')}
            </span>
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={service.toggle}
        disabled={isBusy}
        className={cn(
          'h-8 shrink-0 rounded-md border px-2.5',
          service.isRunning
            ? 'border-green-200 text-green-700 hover:bg-green-100 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-900/30'
            : 'border-red-200 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30',
        )}
      >
        {service.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : service.isRunning ? (
          <Square className="h-3.5 w-3.5 fill-current" />
        ) : (
          <Play className="h-3.5 w-3.5 fill-current" />
        )}
        <span className="ml-1.5 text-xs font-semibold">
          {service.isRunning ? t('action.stop') : t('action.start')}
        </span>
      </Button>
    </div>
  );
}

export const StatusBar: React.FC<StatusBarProps> = ({ isCollapsed = false }) => {
  const { t } = useTranslation();
  const classicStatus = useServiceStatus('classic');
  const ideStatus = useServiceStatus('ide');
  const services: ServiceStatus[] = [
    {
      target: 'classic',
      label: 'Antigravity',
      icon: Workflow,
      ...classicStatus,
    },
    {
      target: 'ide',
      label: 'Antigravity IDE',
      icon: Code2,
      ...ideStatus,
    },
  ];

  const runningCount = services.filter((service) => service.isRunning).length;
  const totalCount = services.length;
  const isChecking = services.some((service) => service.isLoading);
  const hasPendingAction = services.some((service) => service.isPending);
  const summary = isChecking
    ? t('status.checking_short')
    : runningCount === 0
      ? t('status.all_stopped')
      : runningCount === totalCount
        ? t('status.all_running')
        : t('status.partial_running', { running: runningCount, total: totalCount });

  const triggerClassName = isCollapsed
    ? 'mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background/80 text-foreground shadow-sm transition-colors hover:bg-accent'
    : 'flex w-full items-center justify-between overflow-hidden rounded-lg border border-border bg-background/80 px-3 py-2.5 text-sm shadow-sm transition-colors hover:bg-accent/70';

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName} aria-label={t('status.open_dashboard')}>
          {isCollapsed ? (
            <div className="relative">
              {hasPendingAction ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Power className="h-5 w-5" />
              )}
              <span
                className={cn(
                  'border-background absolute -right-1 -bottom-1 h-2.5 w-2.5 rounded-full border-2',
                  runningCount > 0 ? 'bg-green-500' : 'bg-red-500',
                )}
              />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-3">
                <div className="bg-muted text-muted-foreground relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
                  {hasPendingAction ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Activity className="h-4 w-4" />
                  )}
                  <span
                    className={cn(
                      'border-background absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2',
                      runningCount > 0 ? 'bg-green-500' : 'bg-red-500',
                    )}
                  />
                </div>
                <div className="min-w-0 text-left">
                  <div className="text-xs font-semibold tracking-wider uppercase opacity-80">
                    {t('status.services')}
                  </div>
                  <div className="truncate text-sm leading-tight font-medium">{summary}</div>
                </div>
              </div>
              <ChevronUp className="text-muted-foreground ml-2 h-4 w-4 shrink-0" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 p-2">
        <div className="px-2 pb-2">
          <div className="text-sm font-semibold">{t('status.dashboard_title')}</div>
          <div className="text-muted-foreground mt-0.5 text-xs">{summary}</div>
        </div>
        <div className="space-y-1">
          {services.map((service) => (
            <ServiceRow key={service.target} service={service} />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
