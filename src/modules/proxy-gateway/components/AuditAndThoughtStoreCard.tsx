import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ChevronDown, Database, RotateCcw, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ipc } from '@/ipc/manager';
import type { ProxyConfig } from '@/modules/config/types';
import { readServiceConfigErrorCode } from '@/modules/config/service-config.schema';
import { ThoughtDiagnosticsPanel } from './ThoughtDiagnosticsPanel';
import { useAuditDropReset } from './useAuditDropReset';
import { AuditStorageUsage } from '../traffic-monitor/AuditStorageUsage';
import { auditCaptureReasonKey } from '../traffic-monitor/audit-capture-reasons';
import { PersistenceNumberSetting as NumberSetting } from './PersistenceNumberSetting';

interface AuditAndThoughtStoreCardProps {
  config: Pick<ProxyConfig, 'thought_store' | 'traffic_audit'>;
  onChange: (patch: PersistenceSettingsPatch) => Promise<'applied' | 'restart-required' | 'partial-failure'>;
  revisionAvailable?: boolean;
  onReload?: () => Promise<unknown>;
}
export interface PersistenceSettingsPatch {
  traffic_audit?: Partial<ProxyConfig['traffic_audit']>;
  thought_store?: Partial<ProxyConfig['thought_store']>;
}

export function AuditAndThoughtStoreCard({
  config,
  onChange,
  revisionAvailable = true,
  onReload,
}: AuditAndThoughtStoreCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const resetDrops = useAuditDropReset();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'applied' | 'restart-required' | 'partial-failure' | 'conflict' | 'failed'
  >('idle');
  const pending = useRef(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  async function save(patch: PersistenceSettingsPatch) {
    if (pending.current || (patch.traffic_audit !== undefined && !revisionAvailable)) {
      return;
    }
    pending.current = true;
    setReloadFailed(false);
    setSaveState('saving');
    try {
      setSaveState(await onChange(patch));
    } catch (error) {
      setSaveState(readServiceConfigErrorCode(error) === 'conflict' ? 'conflict' : 'failed');
      try {
        await onReload?.();
      } catch {
        setReloadFailed(true);
      }
    } finally {
      pending.current = false;
    }
  }
  const auditStats = useQuery({
    queryKey: ['gateway', 'audit-stats'],
    queryFn: () => ipc.client.gateway.auditStats(),
    refetchInterval: 5_000,
  });
  const thoughtStats = useQuery({
    queryKey: ['gateway', 'thought-stats'],
    queryFn: () => ipc.client.gateway.thoughtStats(),
    refetchInterval: 5_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database size={20} />
          {t('proxy.persistence.title')}
        </CardTitle>
        <CardDescription>{t('proxy.persistence.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!revisionAvailable && (
          <p role="alert" className="text-destructive text-xs">
            {t('proxy.persistence.version-unavailable')}
          </p>
        )}
        {saveState !== 'idle' && (
          <p
            role={saveState === 'failed' || saveState === 'conflict' || saveState === 'partial-failure' ? 'alert' : 'status'}
            className="text-xs"
          >
            {t(`proxy.persistence.save-${saveState}`)}
          </p>
        )}
        {reloadFailed && (
          <p role="alert" className="text-destructive text-xs">
            {t('proxy.persistence.reload-failed')}
          </p>
        )}
        <fieldset disabled={saveState === 'saving'} className="space-y-6">
          <fieldset disabled={!revisionAvailable}>
            <section className="space-y-3" aria-labelledby="traffic-audit-heading">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3
                    id="traffic-audit-heading"
                    className="text-base leading-6 font-semibold tracking-[-0.01em]"
                  >
                    {t('proxy.persistence.audit-title')}
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    {t('proxy.persistence.audit-description')}
                  </p>
                </div>
                <Switch
                  aria-label={t('proxy.persistence.audit-title')}
                  checked={config.traffic_audit.enabled}
                  onCheckedChange={(enabled) => void save({ traffic_audit: { enabled } })}
                />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="audit-successful-probes">
                    {t('proxy.persistence.successful-probes')}
                  </Label>
                  <p className="text-muted-foreground max-w-prose text-xs">
                    {t('proxy.persistence.successful-probes-description')}
                  </p>
                </div>
                <Switch
                  id="audit-successful-probes"
                  checked={config.traffic_audit.capture_successful_probes}
                  disabled={!config.traffic_audit.enabled}
                  onCheckedChange={(capture_successful_probes) =>
                    void save({ traffic_audit: { capture_successful_probes } })
                  }
                />
              </div>
              {auditStats.data && (
                <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>{t('proxy.persistence.rows', { count: auditStats.data.rows })}</span>
                  <span>
                    {t('proxy.persistence.maintenance', {
                      state: t(
                        `proxy.persistence.maintenance-${auditStats.data.maintenanceState ?? 'unknown'}`,
                      ),
                    })}
                  </span>
                  <span>
                    {t('proxy.persistence.queue', {
                      count: auditStats.data.workerPendingCommands,
                    })}
                  </span>
                </div>
              )}
              <div className="text-muted-foreground text-xs">
                <AuditStorageUsage
                  stats={auditStats.data}
                  failed={auditStats.isError}
                  retry={() => void auditStats.refetch()}
                />
              </div>
              {auditStats.data && auditStats.data.droppedCount > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  <AlertTriangle size={14} aria-hidden="true" />
                  {t('proxy.persistence.dropped', {
                    count: auditStats.data.droppedCount,
                    reason: t(auditCaptureReasonKey(auditStats.data.lastDropReason)),
                  })}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 shrink-0 px-2 text-xs"
                    disabled={resetDrops.isPending}
                    aria-busy={resetDrops.isPending}
                    onClick={() => resetDrops.mutate()}
                  >
                    <RotateCcw className="mr-1 h-3 w-3 shrink-0" aria-hidden="true" />
                    {t('traffic.reset-dropped')}
                  </Button>
                </div>
              )}
              {resetDrops.isError && (
                <p role="alert" className="text-destructive text-xs">
                  {t('traffic.reset-dropped-failed')}
                </p>
              )}

              <p className="text-muted-foreground max-w-prose text-xs">
                {t('proxy.persistence.capacity-window')}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {t('proxy.persistence.budget-current', {
                  disk: config.traffic_audit.max_disk_mib,
                  rows: config.traffic_audit.max_rows,
                  commands: config.traffic_audit.max_queue_records,
                  queue: config.traffic_audit.max_queue_mib,
                })}
              </p>
              <p className="text-muted-foreground max-w-prose text-xs">
                {t('proxy.persistence.pressure-note')}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <NumberSetting
                  label={t('proxy.persistence.disk-gib')}
                  value={config.traffic_audit.max_disk_mib / 1024}
                  min={0.125}
                  onCommit={(value) =>
                    save({
                      traffic_audit: {
                        max_disk_mib: Math.min(16_384, Math.max(128, Math.round(value * 1024))),
                      },
                    })
                  }
                />
                <NumberSetting
                  label={t('proxy.persistence.max-rows')}
                  value={config.traffic_audit.max_rows}
                  min={1_000}
                  onCommit={(value) =>
                    save({
                      traffic_audit: {
                        max_rows: Math.min(1_000_000, Math.max(1_000, Math.round(value))),
                      },
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumberSetting
                  label={t('proxy.persistence.queue-records')}
                  value={config.traffic_audit.max_queue_records}
                  min={32}
                  onCommit={(value) =>
                    save({
                      traffic_audit: {
                        max_queue_records: Math.min(4096, Math.max(32, Math.round(value))),
                      },
                    })
                  }
                />
                <NumberSetting
                  label={t('proxy.persistence.queue-mib')}
                  value={config.traffic_audit.max_queue_mib}
                  min={16}
                  onCommit={(value) =>
                    save({
                      traffic_audit: {
                        max_queue_mib: Math.min(64, Math.max(16, Math.round(value))),
                      },
                    })
                  }
                />
              </div>
            </section>
          </fieldset>
          <section className="space-y-3 border-t pt-5" aria-labelledby="thought-store-heading">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3
                  id="thought-store-heading"
                  className="text-base leading-6 font-semibold tracking-[-0.01em]"
                >
                  {t('proxy.persistence.thought-title')}
                </h3>
                <p className="text-muted-foreground text-xs">
                  {t('proxy.persistence.thought-description')}
                </p>
              </div>
              <Switch
                aria-label={t('proxy.persistence.thought-title')}
                checked={config.thought_store.enabled}
                onCheckedChange={(enabled) => void save({ thought_store: { enabled } })}
              />
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
              <span>
                {thoughtStats.data
                  ? t('proxy.persistence.sessions', { count: thoughtStats.data.sessions })
                  : t(
                      thoughtStats.isPending
                        ? 'proxy.persistence.loading'
                        : 'proxy.persistence.thought-stats-unavailable',
                    )}
              </span>
              {thoughtStats.data && <span>{formatBytes(thoughtStats.data.databaseBytes)}</span>}
              <span>
                {t('proxy.persistence.hard-limit', {
                  turns: config.thought_store.max_turns_per_session,
                  memory: config.thought_store.max_session_mib,
                  disk: config.thought_store.max_disk_mib,
                })}
              </span>
            </div>
            {thoughtStats.isError && (
              <p role="alert" className="text-destructive text-xs">
                {t('proxy.persistence.thought-stats-unavailable')}{' '}
                <Button variant="link" size="sm" onClick={() => void thoughtStats.refetch()}>
                  {t('traffic.refresh')}
                </Button>
              </p>
            )}
            {thoughtStats.data && (
              <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
                <span>
                  {thoughtStats.data.records === undefined
                    ? t('proxy.persistence.thought-count-unknown')
                    : t('proxy.persistence.thought-records', { count: thoughtStats.data.records })}
                </span>
                <span>
                  {t('proxy.persistence.thought-memory', {
                    records:
                      thoughtStats.data.memoryRecords ?? t('proxy.persistence.maintenance-unknown'),
                    bytes:
                      thoughtStats.data.memoryBytes === undefined
                        ? t('proxy.persistence.maintenance-unknown')
                        : formatBytes(thoughtStats.data.memoryBytes),
                  })}
                </span>
                <span>
                  {t('proxy.persistence.thought-tool-links', {
                    records:
                      thoughtStats.data.recoverableToolLinks ??
                      t('proxy.persistence.maintenance-unknown'),
                  })}
                </span>
                <span>
                  {t('proxy.persistence.thought-failures', {
                    reads:
                      thoughtStats.data.readFailures ?? t('proxy.persistence.maintenance-unknown'),
                    admission:
                      thoughtStats.data.hydrationAdmissionFailures ??
                      t('proxy.persistence.maintenance-unknown'),
                    writes: thoughtStats.data.writeFailures,
                  })}
                </span>
                <span>
                  {t('proxy.persistence.maintenance', {
                    state: t(
                      `proxy.persistence.maintenance-${thoughtStats.data.maintenanceState ?? 'unknown'}`,
                    ),
                  })}
                </span>
                {thoughtStats.data.lastWriteFailure && (
                  <span role="status">
                    {t('proxy.persistence.thought-write-failure', {
                      reason:
                        thoughtStats.data.lastWriteFailure === 'session_capacity'
                          ? t('proxy.persistence.thought-session-capacity')
                          : t(auditCaptureReasonKey(`audit_${thoughtStats.data.lastWriteFailure}`)),
                    })}
                  </span>
                )}
                {thoughtStats.data.maintenanceBlockedReason && (
                  <span>
                    {t(
                      `proxy.persistence.thought-maintenance-${thoughtStats.data.maintenanceBlockedReason.replaceAll('_', '-')}`,
                    )}
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <NumberSetting
                label={t('proxy.persistence.retention-days')}
                value={config.thought_store.retention_days}
                min={1}
                onCommit={(value) =>
                  save({
                    thought_store: {
                      retention_days: Math.min(3650, Math.max(1, Math.round(value))),
                    },
                  })
                }
              />
              <NumberSetting
                label={t('proxy.persistence.max-sessions')}
                value={config.thought_store.max_sessions}
                min={1}
                onCommit={(value) =>
                  save({
                    thought_store: {
                      max_sessions: Math.min(2000, Math.max(1, Math.round(value))),
                    },
                  })
                }
              />
              <NumberSetting
                label={t('proxy.persistence.thought-cache-turns')}
                value={config.thought_store.max_turns_per_session}
                min={10}
                onCommit={(value) =>
                  save({
                    thought_store: {
                      max_turns_per_session: Math.min(10_000, Math.max(10, Math.round(value))),
                    },
                  })
                }
              />
              <NumberSetting
                label={t('proxy.persistence.thought-cache-mib')}
                value={config.thought_store.max_session_mib}
                min={1}
                onCommit={(value) =>
                  save({
                    thought_store: {
                      max_session_mib: Math.min(64, Math.max(1, Math.round(value))),
                    },
                  })
                }
              />
              <NumberSetting
                label={t('proxy.persistence.thought-disk-mib')}
                value={config.thought_store.max_disk_mib}
                min={128}
                onCommit={(value) =>
                  save({
                    thought_store: {
                      max_disk_mib: Math.min(16_384, Math.max(128, Math.round(value))),
                    },
                  })
                }
              />
            </div>
            <div className="border-t pt-3">
              <Button
                variant="ghost"
                className="w-full justify-between"
                aria-expanded={diagnosticsOpen}
                aria-controls="thought-diagnostics-panel"
                onClick={() => setDiagnosticsOpen((open) => !open)}
              >
                {t('traffic.advanced-diagnostics')}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${diagnosticsOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </Button>
              {diagnosticsOpen && (
                <div id="thought-diagnostics-panel" className="mt-3 min-h-80 rounded-lg border">
                  <ThoughtDiagnosticsPanel />
                </div>
              )}
            </div>
          </section>
        </fieldset>
        <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
          <Button
            variant="outline"
            onClick={async () => {
              await Promise.all([
                ipc.client.gateway.auditRepair(),
                ipc.client.gateway.thoughtRepair(),
              ]);
              await queryClient.invalidateQueries({ queryKey: ['gateway'] });
            }}
          >
            <Wrench className="h-4 w-4" /> {t('traffic.repair-databases')}
          </Button>
          <Button asChild>
            <Link to="/traffic" search={{ page: 0, search: '', tab: 'model' }}>
              <Activity className="h-4 w-4" /> {t('traffic.open-monitor')}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
