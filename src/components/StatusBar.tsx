import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isProcessRunning, startAntigravity, closeAntigravity } from '@/actions/process';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Play, Square, Loader2, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface StatusBarProps {
  isCollapsed?: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({ isCollapsed = false }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: isRunning, isLoading } = useQuery({
    queryKey: ['process', 'status'],
    queryFn: isProcessRunning,
    refetchInterval: 2000,
  });

  const startMutation = useMutation({
    mutationFn: startAntigravity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['process', 'status'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: closeAntigravity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['process', 'status'] });
    },
  });

  const handleToggle = () => {
    if (isRunning) {
      stopMutation.mutate();
    } else {
      startMutation.mutate();
    }
  };

  const isPending = startMutation.isPending || stopMutation.isPending;

  // Collapsed View
  if (isCollapsed) {
    return (
      <div className="flex justify-center py-2">
        <TooltipProvider>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggle}
                disabled={isLoading || isPending}
                className={cn(
                  'h-10 w-10 rounded-lg transition-all duration-300',
                  isRunning
                    ? 'bg-green-100/50 text-green-700 hover:bg-green-100 hover:text-green-800 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50'
                    : 'bg-red-100/50 text-red-700 hover:bg-red-100 hover:text-red-800 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50',
                )}
              >
                {isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Power className="h-5 w-5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="flex items-center gap-2">
              <div
                className={cn('h-2 w-2 rounded-full', isRunning ? 'bg-green-500' : 'bg-red-500')}
              />
              <p>
                {isLoading
                  ? t('status.checking')
                  : isRunning
                    ? t('status.running')
                    : t('status.stopped')}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  // Expanded View
  return (
    <div
      className={cn(
        'flex items-center justify-between overflow-hidden rounded-lg px-3 py-2.5 text-sm font-medium ring-1 transition-colors ring-inset',
        isRunning
          ? 'bg-green-100 text-green-900 ring-green-200 dark:bg-green-900/20 dark:text-green-100 dark:ring-green-900/50'
          : 'bg-red-100 text-red-900 ring-red-200 dark:bg-red-900/20 dark:text-red-100 dark:ring-red-900/50',
      )}
    >
      <div className="flex flex-1 items-start gap-3">
        {isLoading ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : isRunning ? (
          <div className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
        ) : (
          <div className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
        )}
        <div className="flex flex-col gap-1 leading-none">
          <span className="text-xs font-semibold tracking-wider uppercase opacity-80">Status</span>
          <span className="text-sm leading-tight font-medium">
            {isLoading
              ? t('status.checking')
              : isRunning
                ? t('status.running')
                : t('status.stopped')}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        disabled={isLoading || isPending}
        className={cn(
          'ml-2 h-8 shrink-0 rounded-md border px-3 transition-all',
          isRunning
            ? 'border-green-200 bg-green-200/50 text-green-900 hover:bg-green-200 dark:border-green-800 dark:bg-green-800/30 dark:text-green-100 dark:hover:bg-green-800/50'
            : 'border-red-200 bg-red-200/50 text-red-900 hover:bg-red-200 dark:border-red-800 dark:bg-red-800/30 dark:text-red-100 dark:hover:bg-red-800/50',
        )}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isRunning ? (
          <Square className="h-3.5 w-3.5 fill-current" />
        ) : (
          <Play className="h-3.5 w-3.5 fill-current" />
        )}
        <span className="ml-2 font-semibold">
          {isRunning ? t('action.stop') : t('action.start')}
        </span>
      </Button>
    </div>
  );
};
