import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import { formatTrafficTime } from '../traffic-monitor/format-traffic-time';

export function ThoughtDiagnosticsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const sessions = useQuery({
    queryKey: ['gateway', 'thought-sessions', offset, search, model],
    queryFn: () =>
      ipc.client.gateway.thoughtSessions({
        limit: 50,
        model: model || undefined,
        offset,
        search: search || undefined,
      }),
  });
  const records = useQuery({
    enabled: Boolean(selectedKey),
    queryKey: ['gateway', 'thought-records', selectedKey],
    queryFn: () => ipc.client.gateway.thoughtRecords({ sessionKey: selectedKey! }),
  });
  const recordDetail = useQuery({
    enabled: Boolean(selectedKey && selectedRecordId),
    queryKey: ['gateway', 'thought-record', selectedKey, selectedRecordId],
    queryFn: () =>
      ipc.client.gateway.thoughtRecord({ id: selectedRecordId!, sessionKey: selectedKey! }),
  });
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex justify-end border-b px-3 py-2">
        <Button
          size="sm"
          variant={confirmClear ? 'destructive' : 'outline'}
          onClick={async () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            await ipc.client.gateway.thoughtClear();
            setConfirmClear(false);
            setSelectedKey(null);
            setSelectedRecordId(null);
            setOffset(0);
            await queryClient.invalidateQueries({ queryKey: ['gateway'] });
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t(confirmClear ? 'proxy.persistence.confirm-clear' : 'proxy.persistence.clear-thought')}
        </Button>
      </div>
      <div className="grid min-h-80 grid-cols-[minmax(260px,0.75fr)_minmax(0,1.25fr)] gap-4 p-4 max-lg:grid-cols-1">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <form
            className="grid grid-cols-2 gap-2 border-b p-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
              setModel(modelDraft.trim());
              setOffset(0);
            }}
          >
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('traffic.session-key')}
              className="h-8 text-xs"
            />
            <Input
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder={t('traffic.model')}
              className="h-8 text-xs"
            />
          </form>
          <div className="min-h-0 flex-1 overflow-auto">
            {sessions.data?.map((session) => (
              <div key={session.sessionKey} className="group relative border-b">
                <button
                  type="button"
                  className={`w-full cursor-default p-3 pr-11 text-left ${selectedKey === session.sessionKey ? 'bg-primary/5' : 'hover:bg-muted/50'}`}
                  onClick={() => {
                    setSelectedKey(session.sessionKey);
                    setSelectedRecordId(null);
                  }}
                >
                  <div className="truncate font-mono text-xs">{session.sessionKey}</div>
                  <div className="text-muted-foreground mt-1 flex gap-3 text-[11px]">
                    <span>{t('traffic.turns', { count: session.recordCount })}</span>
                    <span>{formatBytes(session.bytes)}</span>
                    <span>{formatTrafficTime(session.lastAccessed)}</span>
                  </div>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={t('traffic.delete-session')}
                  onClick={async () => {
                    await ipc.client.gateway.thoughtDelete({ sessionKey: session.sessionKey });
                    if (selectedKey === session.sessionKey) {
                      setSelectedKey(null);
                      setSelectedRecordId(null);
                    }
                    await queryClient.invalidateQueries({ queryKey: ['gateway'] });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {!sessions.data?.length && (
              <div className="text-muted-foreground p-8 text-center text-sm">
                {t('traffic.no-sessions')}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">{t('traffic.offset', { offset })}</span>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - 50))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={(sessions.data?.length ?? 0) < 50}
                onClick={() => setOffset((current) => current + 50)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>
        <section className="min-h-0 overflow-auto rounded-lg border p-4">
          {!selectedKey ? (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              {t('traffic.select-session')}
            </div>
          ) : (
            <div className="space-y-3">
              {records.data?.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className={`block w-full rounded-lg border p-3 text-left text-sm ${selectedRecordId === record.id ? 'bg-primary/5' : 'hover:bg-muted/40'}`}
                  onClick={() => setSelectedRecordId(record.id)}
                >
                  {record.model ?? t('traffic.unknown-model')} ·{' '}
                  {formatTrafficTime(record.createdAt)} · {formatBytes(record.thoughtBytes)}
                </button>
              ))}
              {recordDetail.data && (
                <div className="rounded-lg border p-3">
                  {recordDetail.data.oversized ? (
                    <p className="text-destructive text-xs">
                      {t('traffic.thought-oversized', { hash: recordDetail.data.oversizedSha256 })}
                    </p>
                  ) : (
                    <pre className="bg-muted/40 max-h-96 overflow-auto rounded p-3 text-xs whitespace-pre-wrap select-text">
                      {recordDetail.data.thought}
                    </pre>
                  )}
                  {recordDetail.data.signature && (
                    <pre className="text-muted-foreground mt-2 overflow-auto text-[11px] select-text">
                      {recordDetail.data.signature}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
