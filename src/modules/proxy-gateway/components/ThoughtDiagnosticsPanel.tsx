import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import { formatTrafficTime } from '../traffic-monitor/format-traffic-time';
import { ThoughtRecordBrowser } from './ThoughtRecordBrowser';

export function ThoughtDiagnosticsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'clear' | 'delete' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
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
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex justify-end border-b px-3 py-2">
        <Button
          size="sm"
          variant={confirmClear ? 'destructive' : 'outline'}
          disabled={pendingAction !== null}
          aria-busy={pendingAction === 'clear'}
          onClick={async () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setPendingAction('clear');
            setActionError(null);
            setReceipt(null);
            try {
              const result = await ipc.client.gateway.thoughtClear();
              if (result.recoveryComplete === false) {
                setActionError(t('proxy.persistence.thought-recovery-partial'));
              }
              setReceipt(
                t('proxy.persistence.thought-delete-receipt', {
                  sessions: result.sessions,
                  records: result.records,
                }),
              );
              setConfirmClear(false);
              setSelectedKey(null);
              setOffset(0);
              await queryClient.invalidateQueries({ queryKey: ['gateway'] });
            } catch {
              setActionError(t('proxy.persistence.thought-mutation-uncertain'));
              await queryClient.invalidateQueries({ queryKey: ['gateway'] });
            } finally {
              setPendingAction(null);
              setConfirmClear(false);
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t(confirmClear ? 'proxy.persistence.confirm-clear' : 'proxy.persistence.clear-thought')}
        </Button>
        {confirmClear && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            onClick={() => setConfirmClear(false)}
          >
            {t('proxy.persistence.cancel-action')}
          </Button>
        )}
      </div>
      {receipt && (
        <p role="status" className="border-b px-3 py-2 text-xs">
          {receipt}
        </p>
      )}
      {actionError && (
        <div role="alert" className="text-destructive border-b px-3 py-2 text-xs">
          {t('proxy.persistence.clear-failed')}: {actionError}
        </div>
      )}
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
              aria-label={t('traffic.session-key')}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('traffic.session-key')}
              className="h-8 text-xs"
            />
            <Input
              value={modelDraft}
              aria-label={t('traffic.model')}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder={t('traffic.model')}
              className="h-8 text-xs"
            />
          </form>
          <div className="min-h-0 flex-1 overflow-auto">
            {sessions.isLoading ? (
              <div className="text-muted-foreground p-8 text-center text-sm">
                {t('proxy.persistence.loading')}
              </div>
            ) : sessions.isError ? (
              <div role="alert" className="text-destructive p-8 text-center text-sm">
                {t('proxy.persistence.load-failed')}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void sessions.refetch();
                  }}
                >
                  {t('proxy.persistence.refresh')}
                </Button>
              </div>
            ) : sessions.data && sessions.data.length > 0 ? (
              sessions.data.map((session) => (
                <div key={session.sessionKey} className="group relative border-b">
                  <button
                    type="button"
                    className={`w-full cursor-default p-3 pr-11 text-left ${selectedKey === session.sessionKey ? 'bg-primary/5' : 'hover:bg-muted/50'}`}
                    onClick={() => {
                      setSelectedKey(session.sessionKey);
                      setConfirmDeleteKey(null);
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
                    variant={confirmDeleteKey === session.sessionKey ? 'destructive' : 'ghost'}
                    className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={t(
                      confirmDeleteKey === session.sessionKey
                        ? 'traffic.confirm-delete-session'
                        : 'traffic.delete-session',
                    )}
                    title={
                      confirmDeleteKey === session.sessionKey
                        ? t('traffic.confirm-delete-session')
                        : t('traffic.delete-session')
                    }
                    disabled={pendingAction !== null}
                    onClick={async () => {
                      if (confirmDeleteKey !== session.sessionKey) {
                        setConfirmDeleteKey(session.sessionKey);
                        return;
                      }
                      setPendingAction('delete');
                      setActionError(null);
                      setReceipt(null);
                      try {
                        const result = await ipc.client.gateway.thoughtDelete({
                          sessionKey: session.sessionKey,
                        });
                        if (result.recoveryComplete === false) {
                          setActionError(t('proxy.persistence.thought-recovery-partial'));
                        }
                        setReceipt(
                          t('proxy.persistence.thought-delete-receipt', {
                            sessions: result.sessions,
                            records: result.records,
                          }),
                        );
                        if (selectedKey === session.sessionKey) {
                          setSelectedKey(null);
                        }
                        await queryClient.invalidateQueries({ queryKey: ['gateway'] });
                      } catch {
                        setActionError(t('proxy.persistence.thought-mutation-uncertain'));
                        await queryClient.invalidateQueries({ queryKey: ['gateway'] });
                      } finally {
                        setPendingAction(null);
                        setConfirmDeleteKey(null);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  {confirmDeleteKey === session.sessionKey && (
                    <div className="space-y-2 px-3 pb-3 text-xs">
                      <p>
                        {t('proxy.persistence.thought-delete-scope', {
                          session: session.sessionKey,
                        })}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pendingAction !== null}
                        onClick={() => setConfirmDeleteKey(null)}
                      >
                        {t('proxy.persistence.cancel-action')}
                      </Button>
                    </div>
                  )}
                </div>
              ))
            ) : (
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
            <ThoughtRecordBrowser key={selectedKey} sessionKey={selectedKey} />
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
