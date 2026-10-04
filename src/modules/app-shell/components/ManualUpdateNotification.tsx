import { useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function ManualUpdateNotification() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<ManualUpdateInfo | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    return window.electron.onManualUpdateAvailable((nextUpdate) => {
      setUpdate(nextUpdate);
      setIsWorking(false);
    });
  }, []);

  useEffect(() => {
    const asyncFn = async () => {
      if (update?.source !== 'electron-updater' || update.state !== 'available') {
        return undefined;
      }

      const version = update.version;
      const result = await window.electron.downloadUpdate().catch(() => {
        setUpdate((current) =>
          current?.version === version && current.state === 'available'
            ? { ...current, state: 'error' }
            : current,
        );
        return { status: 'error', message: 'download failed' };
      });
      setUpdate((current) => {
        if (!current || current.version !== version || current.state !== 'available') {
          return current;
        }
        if (result.status === 'started' || result.status === 'already-downloading') {
          return { ...current, state: 'downloading' };
        }
        if (result.status === 'already-downloaded') {
          return { ...current, state: 'downloaded', downloadPercent: 100 };
        }
        return { ...current, state: 'error' };
      });
    };
    asyncFn();
  }, [update?.source, update?.state, update?.version]);

  if (!update) {
    return null;
  }

  const dismiss = async () => {
    await window.electron.dismissManualUpdate(update.version);
    setUpdate(null);
  };

  const runPrimaryAction = async () => {
    setIsWorking(true);
    try {
      if (update.source === 'electron-updater') {
        if (update.state === 'downloaded') {
          const result = await window.electron.installUpdate();
          if (result.status !== 'started') {
            setUpdate({ ...update, state: 'error' });
            setIsWorking(false);
          }
          return;
        }

        const result = await window.electron.downloadUpdate();
        if (result.status === 'started' || result.status === 'already-downloading') {
          setUpdate({ ...update, state: 'downloading' });
          setIsWorking(false);
          return;
        }

        if (result.status === 'already-downloaded') {
          setUpdate({ ...update, state: 'downloaded' });
          setIsWorking(false);
          return;
        }

        setUpdate({ ...update, state: 'error' });
        setIsWorking(false);
        return;
      }

      await window.electron.openExternalUrl(update.releaseUrl);
      await window.electron.dismissManualUpdate(update.version);
      setUpdate(null);
    } catch {
      if (update.source === 'electron-updater') {
        setUpdate({ ...update, state: 'error' });
      }
      setIsWorking(false);
    }
  };

  const isDownloaded = update.source === 'electron-updater' && update.state === 'downloaded';
  const isDownloading =
    update.source === 'electron-updater' &&
    (update.state === 'downloading' || update.state === 'available');
  const isError = update.source === 'electron-updater' && update.state === 'error';
  const title = isDownloaded ? t('update.downloaded.title') : t('update.available.title');
  const description = isDownloaded
    ? t('update.downloaded.description', { version: update.version })
    : isDownloading
      ? t('update.available.downloading')
      : isError
        ? t('update.checkFailed')
        : t('update.available.description', { version: update.version });
  const actionLabel = isDownloaded
    ? t('update.downloaded.restart')
    : isError
      ? t('action.retry')
      : isWorking
        ? t('update.available.downloading')
        : t('update.available.download');
  const ActionIcon = isDownloaded ? RefreshCw : Download;

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-110 w-[min(calc(100vw-2rem),24rem)]">
      <div className="bg-popover text-popover-foreground pointer-events-auto rounded-md border p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-muted-foreground text-sm">{description}</div>
            {update.platform === 'darwin' && (
              <div className="text-muted-foreground text-xs">
                {t('update.available.macosUnsignedNote')}
              </div>
            )}
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
            aria-label={t('update.available.dismiss')}
            onClick={dismiss}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {isDownloading && (
          <div
            className="bg-muted mt-3 h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={t('update.available.downloading')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={update.downloadPercent}
          >
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${update.downloadPercent ?? 5}%` }}
            />
          </div>
        )}
        {!isDownloading && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" disabled={isWorking && !isDownloaded} onClick={runPrimaryAction}>
              <ActionIcon className="mr-2 h-4 w-4" />
              {actionLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
