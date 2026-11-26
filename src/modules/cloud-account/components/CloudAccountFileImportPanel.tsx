import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useImportCloudAccounts } from '../hooks/useCloudAccounts';
import {
  CloudAccountImportStrategySchema,
  readCloudAccountFileErrorCode,
  type CloudAccountImportSummary,
  type ImportStrategy,
} from '../services/cloud-account-file.schema';

type FileImportFeedback =
  | { status: 'imported'; summary: CloudAccountImportSummary }
  | { status: 'failed'; message: string };

interface CloudAccountFileImportPanelProps {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onImported?: (summary: CloudAccountImportSummary) => void;
  onClose?: () => void;
}

export function CloudAccountFileImportPanel({
  disabled = false,
  onBusyChange,
  onImported,
  onClose,
}: CloudAccountFileImportPanelProps) {
  const { t } = useTranslation();
  const strategyId = useId();
  const [strategy, setStrategy] = useState<ImportStrategy>('merge');
  const [feedback, setFeedback] = useState<FileImportFeedback | null>(null);
  const importMutation = useImportCloudAccounts();
  const isPending = importMutation.isPending;

  const importFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || isPending) {
      return;
    }
    setFeedback(null);
    onBusyChange?.(true);
    try {
      const result = await importMutation.mutateAsync({ strategy });
      if (result.status === 'imported') {
        setFeedback({ status: 'imported', summary: result });
        onImported?.(result);
      }
    } catch (error) {
      const code = readCloudAccountFileErrorCode(error) ?? 'import-failed';
      setFeedback({ status: 'failed', message: t(`cloud.exportImport.file-errors.${code}`) });
    } finally {
      onBusyChange?.(false);
    }
  };

  return (
    <form className="grid gap-4" onSubmit={importFile}>
      <div className="grid gap-2">
        <Label htmlFor={strategyId}>{t('cloud.exportImport.importStrategy')}</Label>
        <Select
          value={strategy}
          disabled={disabled || isPending}
          onValueChange={(value) => {
            const result = CloudAccountImportStrategySchema.safeParse(value);
            if (result.success) {
              setStrategy(result.data);
            }
          }}
        >
          <SelectTrigger id={strategyId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">{t('cloud.exportImport.strategyMerge')}</SelectItem>
            <SelectItem value="overwrite">{t('cloud.exportImport.strategyOverwrite')}</SelectItem>
            <SelectItem value="skip-existing">{t('cloud.exportImport.strategySkip')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {feedback?.status === 'failed' && (
        <p role="alert" className="text-destructive text-sm">
          {feedback.message}
        </p>
      )}
      {feedback?.status === 'imported' && (
        <div role="status" className="space-y-1 text-sm">
          <p>{t('cloud.exportImport.importSuccess', { ...feedback.summary })}</p>
          {feedback.summary.failed > 0 && (
            <div className="text-destructive space-y-1">
              <p>{t('cloud.exportImport.importErrors', { count: feedback.summary.failed })}</p>
              <ul className="list-disc ps-4 break-words">
                {feedback.summary.errors.slice(0, 3).map(({ code, email }, index) => (
                  <li key={index}>
                    {[email, t(`cloud.exportImport.file-errors.${code}`)]
                      .filter(Boolean)
                      .join(': ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onClose && (
          <Button variant="outline" type="button" disabled={isPending} onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        )}
        <Button type="submit" disabled={disabled || isPending} aria-busy={isPending}>
          {isPending && (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {isPending
            ? t('cloud.exportImport.importing')
            : t(onClose ? 'cloud.exportImport.import' : 'cloud.exportImport.import-from-file')}
        </Button>
      </div>
    </form>
  );
}
