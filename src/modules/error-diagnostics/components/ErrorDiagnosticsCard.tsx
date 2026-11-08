import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CommitOnBlurNumberInput } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ipc } from '@/ipc/manager';
import type { ErrorDiagnosticRole } from '../error-window.database';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
import { ErrorDiagnosticBrowser } from './ErrorDiagnosticBrowser';

function mib(bytes: number) {
  return (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function ErrorDiagnosticsCard({
  config,
  available,
}: {
  config: ServiceConfigSnapshot;
  available: boolean;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const pending = useRef(false);
  const [role, setRole] = useState<ErrorDiagnosticRole>('app');
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const sources = useQuery({
    queryKey: ['error-diagnostics', 'sources'],
    queryFn: () => ipc.client.errorDiagnostics.sources(),
    refetchInterval: 5000,
    retry: false,
  });
  const budget = config.errorDiagnosticsBudget;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('error-diagnostics.title')}</CardTitle>
        <CardDescription>{t('error-diagnostics.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <Label htmlFor="error-window-budget">{t('error-diagnostics.budget')}</Label>
            <CommitOnBlurNumberInput
              id="error-window-budget"
              min={0}
              max={10240}
              step={1}
              value={config.error_diagnostics.max_storage_mib}
              disabled={!available || saving}
              className="w-40"
              onCommit={async (event) => {
                const value = Number(event);
                if (!Number.isInteger(value) || value < 0 || value > 10240) {
                  setFeedback(t('error-diagnostics.invalid-budget'));
                  return;
                }
                if (pending.current) {
                  return;
                }
                pending.current = true;
                setSaving(true);
                setFeedback(null);
                try {
                  const result = await ipc.client.config.service.update({
                    error_diagnostics: { max_storage_mib: value },
                  });
                  cache.setQueryData(['serviceConfig'], result.snapshot);
                  setFeedback(
                    t(
                      result.state === 'applied'
                        ? 'error-diagnostics.budget-applied'
                        : 'error-diagnostics.budget-pending',
                    ),
                  );
                  await sources.refetch();
                } catch {
                  setFeedback(t('error-diagnostics.save-failed'));
                } finally {
                  pending.current = false;
                  setSaving(false);
                }
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t('error-diagnostics.budget-effective', {
                value: budget.effectiveMiB,
                source: t(`error-diagnostics.budget-${budget.source}`),
              })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await ipc.client.errorDiagnostics.openDirectory();
              } catch {
                setFeedback(t('error-diagnostics.directory-failed'));
              }
            }}
          >
            {t('error-diagnostics.open-directory')}
          </Button>
        </div>
        {!available && (
          <p role="alert" className="text-destructive text-sm">
            {t('error-diagnostics.settings-unavailable')}
          </p>
        )}
        {budget.ignoredEnvironmentOverride && (
          <p role="alert" className="text-destructive text-sm">
            {t('error-diagnostics.invalid-environment')}
          </p>
        )}
        {feedback && (
          <p role="status" className="text-sm">
            {feedback}
          </p>
        )}
        {sources.isPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('error-diagnostics.loading')}
          </p>
        ) : sources.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <p>{t('error-diagnostics.load-failed')}</p>
            <Button variant="outline" size="sm" onClick={() => void sources.refetch()}>
              {t('error-diagnostics.retry')}
            </Button>
          </div>
        ) : (
          <dl className="divide-y text-sm">
            {sources.data.map((source) => (
              <div key={source.role} className="space-y-2 py-3">
                <dt className="font-medium">{t(`error-diagnostics.role-${source.role}`)}</dt>
                <dd className="space-y-1 text-xs">
                  {source.state === 'unavailable' ||
                  source.status.storage.state === 'unavailable' ? (
                    <p className="text-muted-foreground">
                      {t('error-diagnostics.source-unavailable')}
                    </p>
                  ) : (
                    <p className="tabular-nums">
                      {t('error-diagnostics.usage', {
                        used: mib(source.status.storage.databaseBytes),
                        budget: mib(source.status.storage.allocationBytes),
                        count: source.status.storage.records,
                      })}
                    </p>
                  )}
                  {source.state === 'available' && (
                    <>
                      <p className="text-muted-foreground break-all select-text">
                        {source.status.storagePath}
                      </p>
                      <p className="text-muted-foreground tabular-nums">
                        {t('error-diagnostics.counters', {
                          persisted: source.status.counters.persisted,
                          pending: source.status.queue?.pendingCommands ?? 0,
                          lost:
                            source.status.counters.fallbackEvicted +
                            source.status.counters.discarded,
                          memory: source.status.fallbackRecords,
                        })}
                      </p>
                      {source.status.lastFailure && (
                        <p role="status" className="text-destructive">
                          {t('error-diagnostics.capture-degraded')}
                        </p>
                      )}
                      {source.status.maintenanceBlocked && (
                        <p role="status" className="text-destructive">
                          {t('error-diagnostics.reclaim-pending')}
                        </p>
                      )}
                      {source.status.storage.state === 'ready' &&
                        source.status.storage.allocationBytes !== budget[`${source.role}Bytes`] && (
                          <p role="status" className="text-destructive">
                            {t('error-diagnostics.budget-pending')}
                          </p>
                        )}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={expanded}
          aria-controls="local-errors-browser"
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'error-diagnostics.hide-records' : 'error-diagnostics.browse')}
        </Button>
        {expanded && (
          <section id="local-errors-browser" className="space-y-4 border-t pt-4">
            <Select
              value={role}
              onValueChange={(value) => {
                if (value === 'app' || value === 'core') {
                  setRole(value);
                }
              }}
            >
              <SelectTrigger className="w-52" aria-label={t('error-diagnostics.source')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="app">{t('error-diagnostics.role-app')}</SelectItem>
                <SelectItem value="core">{t('error-diagnostics.role-core')}</SelectItem>
              </SelectContent>
            </Select>
            <ErrorDiagnosticBrowser key={role} role={role} />
          </section>
        )}
      </CardContent>
    </Card>
  );
}
