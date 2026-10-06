import { useQuery } from '@tanstack/react-query';
import { CheckCircle, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';

interface OpenCodeConfigViewerDialogProps {
  onOpenChange: (open: boolean) => void;
}

export function OpenCodeConfigViewerDialog({ onOpenChange }: OpenCodeConfigViewerDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const previewQuery = useQuery({
    queryKey: ['gateway', 'openCodeConfigPreview'],
    queryFn: () => ipc.client.gateway.readOpenCodeConfig(),
    retry: false,
    staleTime: 0,
  });

  const copyPreview = async () => {
    if (!previewQuery.data) {
      return;
    }

    try {
      await navigator.clipboard.writeText(previewQuery.data.content);
      setCopied(true);
      toast({
        title: t('proxy.open-code.config-copied', 'Redacted configuration copied'),
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: t('proxy.open-code.config-copy-failed', 'Failed to copy configuration'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>
            {t('proxy.open-code.config-viewer-title', 'OpenCode configuration')}
          </DialogTitle>
          <DialogDescription className="break-all">
            {previewQuery.data?.fileName ??
              t('proxy.open-code.config-viewer-description', 'Read-only configuration preview')}
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
          aria-busy={previewQuery.isFetching}
        >
          {previewQuery.isLoading ? (
            <FeedbackState
              kind="loading"
              title={t('common.loading')}
              description={t('common.reading-settings')}
            />
          ) : previewQuery.error ? (
            <FeedbackState
              kind="error"
              title={t('proxy.open-code.config-load-failed')}
              description={t('proxy.open-code.config-retry-description')}
            >
              <Button
                variant="outline"
                disabled={previewQuery.isFetching}
                onClick={() => void previewQuery.refetch()}
              >
                {t('action.retry')}
              </Button>
            </FeedbackState>
          ) : (
            <pre className="bg-muted text-foreground overflow-x-auto rounded-md border p-4 font-mono text-xs leading-relaxed whitespace-pre">
              {previewQuery.data?.content}
            </pre>
          )}
        </div>

        <div className="bg-muted text-muted-foreground shrink-0 border-t px-6 py-3 text-xs">
          {t(
            'proxy.open-code.config-redacted-notice',
            'Comments are omitted and sensitive fields are redacted before this preview reaches the renderer.',
          )}
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
          <Button
            type="button"
            onClick={copyPreview}
            disabled={!previewQuery.data || previewQuery.isError}
          >
            {copied ? <CheckCircle className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
            {t('proxy.open-code.copy-config', 'Copy redacted configuration')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
