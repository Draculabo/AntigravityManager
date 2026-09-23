import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ChevronDown, Database, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ipc } from '@/ipc/manager';
import type { ProxyConfig } from '@/modules/config/types';
import { ThoughtDiagnosticsPanel } from './ThoughtDiagnosticsPanel';

interface AuditAndThoughtStoreCardProps {
  config: Pick<ProxyConfig, 'thought_store' | 'traffic_audit'>;
  onChange: (patch: Pick<ProxyConfig, 'thought_store' | 'traffic_audit'>) => void | Promise<void>;
}

export function AuditAndThoughtStoreCard({ config, onChange }: AuditAndThoughtStoreCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
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
        <section className="space-y-3" aria-labelledby="traffic-audit-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="traffic-audit-heading" className="font-medium">
                {t('proxy.persistence.audit-title')}
              </h3>
              <p className="text-muted-foreground text-xs">
                {t('proxy.persistence.audit-description')}
              </p>
            </div>
            <Switch
              aria-label={t('proxy.persistence.audit-title')}
              checked={config.traffic_audit.enabled}
              onCheckedChange={(enabled) =>
                onChange({
                  ...config,
                  traffic_audit: { ...config.traffic_audit, enabled },
                })
              }
            />
          </div>

          {auditStats.data && (
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>{t('proxy.persistence.rows', { count: auditStats.data.rows })}</span>
              <span>{formatBytes(auditStats.data.databaseBytes)}</span>
              <span>
                {t('proxy.persistence.queue', {
                  count: auditStats.data.workerPendingCommands,
                })}
              </span>
            </div>
          )}
          {auditStats.data && auditStats.data.droppedCount > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <AlertTriangle size={14} aria-hidden="true" />
              {t('proxy.persistence.dropped', {
                count: auditStats.data.droppedCount,
                reason: auditStats.data.lastDropReason ?? 'unknown',
              })}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <NumberSetting
              label={t('proxy.persistence.disk-gib')}
              value={config.traffic_audit.max_disk_mib / 1024}
              min={0.125}
              onCommit={(value) =>
                onChange({
                  ...config,
                  traffic_audit: {
                    ...config.traffic_audit,
                    max_disk_mib: Math.min(16_384, Math.max(128, Math.round(value * 1024))),
                  },
                })
              }
            />
            <NumberSetting
              label={t('proxy.persistence.body-hours')}
              value={config.traffic_audit.body_retention_hours}
              min={1}
              onCommit={(value) =>
                onChange({
                  ...config,
                  traffic_audit: {
                    ...config.traffic_audit,
                    body_retention_hours: Math.min(24 * 365, Math.max(1, Math.round(value))),
                  },
                })
              }
            />
            <NumberSetting
              label={t('proxy.persistence.summary-days')}
              value={config.traffic_audit.summary_retention_days}
              min={1}
              onCommit={(value) =>
                onChange({
                  ...config,
                  traffic_audit: {
                    ...config.traffic_audit,
                    summary_retention_days: Math.min(3650, Math.max(1, Math.round(value))),
                  },
                })
              }
            />
            <NumberSetting
              label={t('proxy.persistence.max-rows')}
              value={config.traffic_audit.max_rows}
              min={1_000}
              onCommit={(value) =>
                onChange({
                  ...config,
                  traffic_audit: {
                    ...config.traffic_audit,
                    max_rows: Math.min(1_000_000, Math.max(1_000, Math.round(value))),
                  },
                })
              }
            />
          </div>
        </section>

        <section className="space-y-3 border-t pt-5" aria-labelledby="thought-store-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="thought-store-heading" className="font-medium">
                {t('proxy.persistence.thought-title')}
              </h3>
              <p className="text-muted-foreground text-xs">
                {t('proxy.persistence.thought-description')}
              </p>
            </div>
            <Switch
              aria-label={t('proxy.persistence.thought-title')}
              checked={config.thought_store.enabled}
              onCheckedChange={(enabled) =>
                onChange({
                  ...config,
                  thought_store: { ...config.thought_store, enabled },
                })
              }
            />
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
            <span>
              {t('proxy.persistence.sessions', { count: thoughtStats.data?.sessions ?? 0 })}
            </span>
            <span>{formatBytes(thoughtStats.data?.databaseBytes ?? 0)}</span>
            <span>{t('proxy.persistence.hard-limit')}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberSetting
              label={t('proxy.persistence.retention-days')}
              value={config.thought_store.retention_days}
              min={1}
              onCommit={(value) =>
                onChange({
                  ...config,
                  thought_store: {
                    ...config.thought_store,
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
                onChange({
                  ...config,
                  thought_store: {
                    ...config.thought_store,
                    max_sessions: Math.min(100_000, Math.max(1, Math.round(value))),
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

function NumberSetting({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (value: number) => void | Promise<void>;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            onCommit(next);
          }
        }}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
