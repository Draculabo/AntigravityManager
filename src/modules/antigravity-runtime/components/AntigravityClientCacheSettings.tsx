import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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

  const handleOpenDialog = async () => {
    setIsLoadingPaths(true);
    try {
      setCachePaths(await getAntigravityClientCachePaths());
    } catch {
      setCachePaths([]);
    } finally {
      setIsLoadingPaths(false);
      setIsDialogOpen(true);
    }
  };

  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      const result = await clearAntigravityClientCache();
      if (result.clearedPaths.length > 0) {
        toast({
          title: t('settings.cache.clearedTitle'),
          description: t('settings.cache.clearedDescription', {
            size: (result.totalSizeFreed / 1024 / 1024).toFixed(2),
          }),
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
        title: t('settings.cache.failedTitle'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.cache.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('settings.cache.dialogDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm font-medium">{t('settings.cache.pathsLabel')}</p>
            {cachePaths.length > 0 ? (
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                {cachePaths.map((cachePath) => (
                  <p className="text-muted-foreground font-mono text-xs break-all" key={cachePath}>
                    {cachePath}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground rounded-md border p-3 text-sm">
                {t('settings.cache.noPaths')}
              </p>
            )}
            <p className="text-sm text-orange-600 dark:text-orange-400">
              {t('settings.cache.warning')}
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isClearing}>
                {t('settings.cache.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={isClearing}
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
