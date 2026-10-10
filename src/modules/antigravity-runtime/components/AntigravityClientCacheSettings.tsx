import { useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import {
  clearAntigravityClientCache,
  getAntigravityClientCachePaths,
} from '@/modules/antigravity-runtime/actions/cache';

export function AntigravityClientCacheSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [cachePaths, setCachePaths] = useState<string[]>([]);
  const [isLoadingPaths, setIsLoadingPaths] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [pathsFailed, setPathsFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clearing = useRef(false);

  const handleOpenDialog = async () => {
    setIsDialogOpen(true);
    setIsLoadingPaths(true);
    setPathsFailed(false);
    try {
      setCachePaths(await getAntigravityClientCachePaths());
    } catch {
      setCachePaths([]);
      setPathsFailed(true);
    } finally {
      setIsLoadingPaths(false);
    }
  };

  const handleClearCache = async () => {
    if (clearing.current || pathsFailed || isLoadingPaths) {
      return;
    }
    clearing.current = true;
    setIsClearing(true);
    try {
      const result = await clearAntigravityClientCache();
      if (result.clearedPaths.length > 0) {
        toast({
          title: t(
            result.errors.length > 0
              ? 'settings.cache.partial-title'
              : 'settings.cache.clearedTitle',
          ),
          description: t(
            result.errors.length > 0
              ? 'settings.cache.partial-description'
              : 'settings.cache.clearedDescription',
            {
              size: (result.totalSizeFreed / 1024 / 1024).toFixed(2),
              count: result.errors.length,
            },
          ),
          variant: result.errors.length > 0 ? 'warning' : 'success',
        });
      } else if (result.errors.length > 0) {
        toast({
          title: t('settings.cache.failedTitle'),
          description: result.errors[0],
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('settings.cache.notFoundTitle'),
        });
      }
    } catch (error) {
      toast({
        error,
        title: t('settings.cache.failedTitle'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      clearing.current = false;
      setIsClearing(false);
      setIsDialogOpen(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.cache.title')}</CardTitle>
          <CardDescription>{t('settings.cache.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            disabled={isLoadingPaths}
            onClick={handleOpenDialog}
          >
            {isLoadingPaths ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t('settings.cache.clear')}
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          if (!isClearing) {
            setIsDialogOpen(open);
          }
        }}
      >
        <DialogContent
          closeDisabled={isClearing}
          aria-busy={isClearing || isLoadingPaths}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('settings.cache.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('settings.cache.dialogDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {isLoadingPaths ? (
              <FeedbackState
                kind="loading"
                title={t('common.loading')}
                description={t('common.reading-settings')}
              />
            ) : pathsFailed ? (
              <FeedbackState
                kind="error"
                title={t('settings.cache.paths-failed')}
                description={t('settings.cache.paths-retry-description')}
              >
                <Button
                  variant="outline"
                  disabled={isLoadingPaths}
                  onClick={() => void handleOpenDialog()}
                >
                  {t('action.retry')}
                </Button>
              </FeedbackState>
            ) : (
              <>
                <p className="text-sm font-medium">{t('settings.cache.pathsLabel')}</p>
                {cachePaths.length > 0 ? (
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                    {cachePaths.map((cachePath) => (
                      <p
                        className="text-muted-foreground font-mono text-xs break-all"
                        key={cachePath}
                      >
                        {cachePath}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground rounded-md border p-3 text-sm">
                    {t('settings.cache.noPaths')}
                  </p>
                )}
                <p className="bg-warning-soft text-warning border-warning-border rounded-md border p-3 text-sm">
                  {t('settings.cache.warning')}
                </p>
              </>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" autoFocus disabled={isClearing}>
                {t('settings.cache.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={isClearing || pathsFailed || isLoadingPaths || cachePaths.length === 0}
              aria-busy={isClearing}
              onClick={handleClearCache}
            >
              {isClearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isClearing ? t('settings.cache.clearing') : t('settings.cache.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
