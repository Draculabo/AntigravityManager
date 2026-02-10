import { createFileRoute } from '@tanstack/react-router';
import { CloudAccountList } from '@/components/CloudAccountList';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { getLocalizedErrorMessage } from '@/utils/errorMessages';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

function HomePage() {
  return (
    <div className="container mx-auto max-w-4xl p-6">
      <CloudAccountList />
    </div>
  );
}

function HomePageErrorBoundary({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const hasShownToastRef = useRef(false);

  useEffect(() => {
    if (hasShownToastRef.current) {
      return;
    }

    toast({
      title: t('error.generic'),
      description: getLocalizedErrorMessage(error, t),
      variant: 'destructive',
    });
    hasShownToastRef.current = true;
  }, [error, t, toast]);

  return (
    <div className="container mx-auto max-w-4xl p-6">
      <div className="rounded-lg border border-dashed p-8 text-center">
        <div className="text-lg font-semibold">{t('error.generic')}</div>
        <div className="text-muted-foreground mt-2 text-sm">{t('action.retry')}</div>
        <Button className="mt-4" variant="outline" onClick={() => reset()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('action.retry')}
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: HomePage,
  errorComponent: HomePageErrorBoundary,
});
