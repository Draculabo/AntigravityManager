import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { importCloudAccountRefreshToken } from '../actions/cloud';
import { QUERY_KEYS } from '../hooks/useCloudAccounts';
import { parseCloudAccountCredentialInput } from '../services/cloud-account-credential-input';
import { CloudAccountFileImportPanel } from './CloudAccountFileImportPanel';

type ImportResult = Awaited<ReturnType<typeof importCloudAccountRefreshToken>>;
type FailedRow = {
  index: number;
  credential: string;
  reason: Extract<ImportResult, { status: 'failed' }>['reason'] | 'request-failed';
};
type Batch =
  | { phase: 'idle' }
  | { phase: 'running'; processed: number; total: number }
  | {
      phase: 'done';
      counts: Record<'added' | 'updated' | 'skipped', number>;
      failed: FailedRow[];
    };

interface CloudAccountCredentialImportPanelProps {
  onBusyChange: (busy: boolean) => void;
  onComplete: () => void;
}

export function CloudAccountCredentialImportPanel({
  onBusyChange,
  onComplete,
}: CloudAccountCredentialImportPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [batch, setBatch] = useState<Batch>({ phase: 'idle' });
  const [fileBusy, setFileBusy] = useState(false);
  const running = batch.phase === 'running';

  async function importRows(
    rows: ReadonlyArray<Pick<FailedRow, 'index' | 'credential'>>,
    previousCounts: Record<'added' | 'updated' | 'skipped', number>,
  ) {
    const counts = { ...previousCounts };
    const failed: FailedRow[] = [];
    setInput('');
    setError(undefined);
    onBusyChange(true);
    setBatch({ phase: 'running', processed: 0, total: rows.length });

    for (const [index, row] of rows.entries()) {
      try {
        const result = await importCloudAccountRefreshToken(row.credential);
        if (result.status === 'failed') {
          failed.push({ ...row, reason: result.reason });
        } else {
          counts[result.status] += 1;
        }
      } catch {
        failed.push({ ...row, reason: 'request-failed' });
      }
      setBatch({ phase: 'running', processed: index + 1, total: rows.length });
    }

    onBusyChange(false);
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    if (failed.length === 0) {
      toast({
        title: t('cloud.add-flow.credentials.result', { ...counts, failed: 0 }),
        variant: 'success',
      });
      onComplete();
      return;
    }
    setBatch({ phase: 'done', counts, failed });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || fileBusy) {
      return;
    }
    const parsed = parseCloudAccountCredentialInput(input);
    if (parsed.status === 'invalid') {
      setError(parsed.reason);
      return;
    }
    importRows(
      parsed.credentials.map((credential, index) => ({ credential, index })),
      { added: 0, updated: 0, skipped: parsed.duplicates },
    );
  }

  return (
    <div className="grid gap-4">
      <form className="grid gap-2" onSubmit={submit}>
        <Label htmlFor="add-account-credentials">{t('cloud.add-flow.credentials.label')}</Label>
        <Textarea
          id="add-account-credentials"
          className="min-h-24 resize-y font-mono text-xs"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(undefined);
          }}
          placeholder={t('cloud.add-flow.credentials.placeholder')}
          aria-describedby="add-account-credentials-help"
          aria-invalid={Boolean(error)}
          autoComplete="off"
          spellCheck={false}
          disabled={running || fileBusy}
        />
        <p id="add-account-credentials-help" className="text-muted-foreground text-xs">
          {t('cloud.add-flow.credentials.help')}
        </p>
        <details className="text-xs">
          <summary className="focus-visible:ring-ring w-fit cursor-pointer rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
            {t('cloud.add-flow.credentials.examples')}
          </summary>
          <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-2">
            {`refresh-token-example\n\n{"refresh_token":"refresh-token-example"}`}
          </pre>
        </details>
        {error && (
          <p role="alert" className="text-destructive">
            {t(`cloud.add-flow.credentials.errors.${error}`)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={running || fileBusy || !input.trim()}>
            {running && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {t('cloud.add-flow.credentials.import')}
          </Button>
          {batch.phase === 'running' && (
            <p role="status" className="text-muted-foreground text-sm tabular-nums">
              {t('cloud.add-flow.credentials.progress', batch)}
            </p>
          )}
        </div>
      </form>
      {batch.phase === 'done' && (
        <div className="grid gap-2 rounded-md border p-3">
          <p role="status" className="text-sm tabular-nums">
            {t('cloud.add-flow.credentials.result', {
              ...batch.counts,
              failed: batch.failed.length,
            })}
          </p>
          {batch.failed.length > 0 && (
            <>
              <ul className="text-destructive max-h-28 space-y-0.5 overflow-y-auto text-xs">
                {batch.failed.map(({ index, reason }) => (
                  <li key={index}>
                    {t('cloud.add-flow.credentials.row-error', {
                      position: index + 1,
                      error: t(`cloud.add-flow.credentials.errors.${reason}`),
                    })}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                className="justify-self-start"
                disabled={fileBusy}
                onClick={() => {
                  importRows(batch.failed, batch.counts);
                }}
              >
                {t('cloud.add-flow.credentials.retry')}
              </Button>
            </>
          )}
        </div>
      )}
      <details className="border-t pt-3">
        <summary className="focus-visible:ring-ring cursor-pointer rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
          {t('cloud.exportImport.import-from-file')}
        </summary>
        <div className="mt-3">
          <CloudAccountFileImportPanel
            disabled={running}
            onBusyChange={(busy) => {
              setFileBusy(busy);
              onBusyChange(busy);
            }}
          />
        </div>
      </details>
    </div>
  );
}
