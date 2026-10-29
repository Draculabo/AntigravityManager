import { createFileRoute } from '@tanstack/react-router';
import { WorkspacesView } from '@/modules/workspace/components/WorkspacesView';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

function WorkspacesRoute() {
  return (
    <div className="container">
      <WorkspacesView />
    </div>
  );
}

function WorkspacesErrorBoundary({ error, reset }: { error: unknown; reset: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const hasShownToastRef = useRef(false);

  useEffect(() => {
    if (hasShownToastRef.current) {
      return;
    }

    toast({
      error,
      title: t('error.generic', 'An error occurred'),
      description: getLocalizedErrorMessage(error, t),
      variant: 'destructive',
    });
    hasShownToastRef.current = true;
  }, [error, t, toast]);

  return (
    <div className="container">
      <div className="rounded-lg border border-dashed p-8 text-center">
        <div className="text-lg font-semibold">{t('error.generic', 'An error occurred')}</div>
        <div className="text-muted-foreground mt-2 text-sm">
          {getLocalizedErrorMessage(error, t)}
        </div>
        <Button className="mt-4" variant="outline" onClick={() => reset()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('action.retry', 'Retry')}
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/workspaces')({
  component: WorkspacesRoute,
  errorComponent: WorkspacesErrorBoundary,
});
