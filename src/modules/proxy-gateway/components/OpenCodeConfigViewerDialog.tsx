import { useQuery } from '@tanstack/react-query';
import { CheckCircle, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
      toast({ title: t('proxy.open-code.config-copied', 'Redacted configuration copied') });
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
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b p-5 pb-4">
          <DialogTitle>
            {t('proxy.open-code.config-viewer-title', 'OpenCode configuration')}
          </DialogTitle>
          <DialogDescription>
            {previewQuery.data?.fileName ??
              t('proxy.open-code.config-viewer-description', 'Read-only configuration preview')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 px-5">
          {previewQuery.isLoading ? (
            <div className="flex min-h-64 items-center justify-center">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : previewQuery.error ? (
            <div className="text-destructive flex min-h-64 items-center justify-center text-sm">
              {previewQuery.error instanceof Error
                ? previewQuery.error.message
                : t('proxy.open-code.config-load-failed', 'Failed to load configuration')}
            </div>
          ) : (
            <pre className="max-h-[58vh] overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-xs leading-relaxed whitespace-pre text-gray-100">
              {previewQuery.data?.content}
            </pre>
          )}
        </div>

        <div className="bg-muted/40 border-t px-5 py-3 text-xs">
          {t(
            'proxy.open-code.config-redacted-notice',
            'Comments are omitted and sensitive fields are redacted before this preview reaches the renderer.',
          )}
        </div>
        <DialogFooter className="border-t p-5 pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
          <Button type="button" onClick={copyPreview} disabled={!previewQuery.data}>
            {copied ? <CheckCircle className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
            {t('proxy.open-code.copy-config', 'Copy redacted configuration')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
