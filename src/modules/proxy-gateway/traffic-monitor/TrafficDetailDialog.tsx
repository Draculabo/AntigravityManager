import { lazy, Suspense, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { AlertTriangle, Clipboard, Clock3, Server } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ipc } from '@/ipc/manager';
import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';

import { formatTrafficTime } from './format-traffic-time';

const AuditBodyViewer = lazy(async () => ({
  default: (await import('./AuditBodyViewer')).AuditBodyViewer,
}));

interface TrafficDetailDialogProps {
  id: string | null;
  onOpenChange: (open: boolean) => void;
  onCopyCurl: (id: string, attemptId?: string) => void;
  includeCredentials: boolean;
}

export function TrafficDetailDialog(props: TrafficDetailDialogProps) {
  return <TrafficDetailDialogContent key={props.id ?? 'none'} {...props} />;
}

function TrafficDetailDialogContent({
  id,
  onOpenChange,
  onCopyCurl,
  includeCredentials,
}: TrafficDetailDialogProps) {
  const { t } = useTranslation();
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const detail = useQuery({
    enabled: Boolean(id),
    queryKey: ['gateway', 'traffic-detail', id],
    queryFn: () => ipc.client.gateway.auditDetail({ id: id! }),
  });
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);

  const requestDetail = detail.data?.recordKind === 'request' ? detail.data : null;
  const effectiveAttemptId = selectedAttemptId ?? requestDetail?.attempts.at(-1)?.id ?? null;
  const preferredBody =
    requestDetail?.bodies.find(
      (body) => body.ownerId === effectiveAttemptId && body.direction === 'response',
    ) ??
    requestDetail?.bodies.find(
      (body) => body.ownerKind === 'parent' && body.direction === 'response',
    );
  const effectiveBodyId =
    selectedBodyId ?? preferredBody?.id ?? requestDetail?.bodies[0]?.id ?? null;
  const selectedBody: TrafficAuditBodyDescriptor | null =
    requestDetail?.bodies.find((body) => body.id === effectiveBodyId) ?? null;

  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[90dvh] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 xl:max-w-7xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('traffic.detail-title')}
            {requestDetail && <OutcomeBadge outcome={requestDetail.request.outcome} />}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {requestDetail?.request.id ?? id}
          </DialogDescription>
          {requestDetail && requestDetail.request.trafficClass !== 'ipc' && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    aria-label={`${t('traffic.copy-request-curl')}${includeCredentials ? ` · ${t('traffic.current-credential')}` : ''}`}
                    onClick={() => onCopyCurl(requestDetail.request.id)}
                  >
                    <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('traffic.copy-request-curl')}
                  {includeCredentials ? ` · ${t('traffic.current-credential')}` : ''}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </DialogHeader>

        {detail.isLoading && (
          <div
            role="status"
            className="text-muted-foreground flex flex-1 items-center justify-center text-sm"
          >
            {t('traffic.loading-detail')}
          </div>
        )}
        {detail.isError && (
          <div
            role="alert"
            className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm"
          >
            <p>{t('traffic.detail-load-failed')}</p>
            <Button variant="outline" onClick={() => detail.refetch()}>
              {t('action.retry')}
            </Button>
          </div>
        )}
        {!detail.isLoading && !detail.isError && !detail.data && (
          <p className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
            {t('traffic.detail-not-found')}
          </p>
        )}
        {detail.data?.recordKind === 'admin' && (
          <div className="m-5 max-w-3xl rounded-lg border p-5">
            <div className="mb-3 flex items-center gap-2 font-semibold">
              <Server className="h-4 w-4" /> {t('traffic.system-operation')}
            </div>
            <DefinitionList
              values={[
                { label: t('traffic.operation'), value: detail.data.event.operation },
                { label: t('traffic.result'), value: detail.data.event.outcome },
                { label: t('traffic.fields.affected'), value: detail.data.event.affectedCount },
                { label: t('traffic.time'), value: formatTrafficTime(detail.data.event.timestamp) },
                { label: t('traffic.fields.error'), value: detail.data.event.error },
              ]}
            />
          </div>
        )}
        {requestDetail && (
          <>
            <dl className="bg-muted/20 grid shrink-0 grid-cols-2 gap-3 border-b px-5 py-3 text-sm sm:grid-cols-4">
              {[
                [t('traffic.status'), requestDetail.request.status ?? '—'],
                [
                  t('traffic.duration'),
                  requestDetail.request.durationMs === null
                    ? '—'
                    : `${requestDetail.request.durationMs} ms`,
                ],
                [t('traffic.input-tokens'), requestDetail.request.inputTokens ?? '—'],
                [t('traffic.output-tokens'), requestDetail.request.outputTokens ?? '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="mt-1 font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="hidden min-h-0 flex-1 grid-cols-[minmax(260px,0.8fr)_minmax(240px,0.7fr)_minmax(420px,1.5fr)] xl:grid">
              <MetadataPane detail={requestDetail} />
              <AttemptPane
                attempts={requestDetail.attempts}
                parentId={requestDetail.request.id}
                onCopyCurl={onCopyCurl}
                selectedAttemptId={effectiveAttemptId}
                onSelect={(attemptId) => {
                  setSelectedAttemptId(attemptId);
                  const preferred = requestDetail.bodies.find(
                    (body) => body.ownerId === attemptId && body.direction === 'response',
                  );
                  if (preferred) {
                    setSelectedBodyId(preferred.id);
                  }
                }}
              />
              <PayloadPane
                bodies={requestDetail.bodies}
                selectedBody={selectedBody}
                onSelect={setSelectedBodyId}
              />
            </div>
            <Tabs defaultValue="metadata" className="flex min-h-0 flex-1 flex-col xl:hidden">
              <TabsList
                aria-label={t('traffic.detail-title')}
                className="mx-4 mt-3 max-w-[calc(100%-2rem)] justify-start overflow-x-auto"
              >
                <TabsTrigger value="metadata">{t('traffic.metadata')}</TabsTrigger>
                <TabsTrigger value="attempts">
                  {t('traffic.attempts', { count: requestDetail.attempts.length })}
                </TabsTrigger>
                <TabsTrigger value="payloads">
                  {t('traffic.payloads', { count: requestDetail.bodies.length })}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="metadata" className="min-h-0 flex-1 overflow-auto">
                <MetadataPane detail={requestDetail} borderless />
              </TabsContent>
              <TabsContent value="attempts" className="min-h-0 flex-1 overflow-auto">
                <AttemptPane
                  attempts={requestDetail.attempts}
                  parentId={requestDetail.request.id}
                  onCopyCurl={onCopyCurl}
                  selectedAttemptId={effectiveAttemptId}
                  onSelect={setSelectedAttemptId}
                  borderless
                />
              </TabsContent>
              <TabsContent value="payloads" className="min-h-0 flex-1 overflow-hidden">
                <PayloadPane
                  bodies={requestDetail.bodies}
                  selectedBody={selectedBody}
                  onSelect={setSelectedBodyId}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

type RequestDetail = Extract<
  NonNullable<Awaited<ReturnType<typeof ipc.client.gateway.auditDetail>>>,
  { recordKind: 'request' }
>;

function MetadataPane({
  detail,
  borderless = false,
}: {
  detail: RequestDetail;
  borderless?: boolean;
}) {
  const { t } = useTranslation();
  const request = detail.request;
  return (
    <section className={`min-h-0 overflow-auto p-4 ${borderless ? '' : 'border-r'}`}>
      <h3 className="mb-3 text-sm font-semibold">{t('traffic.client-request')}</h3>
      <DefinitionList
        values={[
          { label: t('traffic.fields.category'), value: t(`traffic.${request.trafficClass}`) },
          { label: t('traffic.time'), value: formatTrafficTime(request.timestamp) },
          { label: t('traffic.fields.method'), value: request.method },
          { label: t('traffic.endpoint'), value: request.url },
          { label: t('traffic.protocol'), value: request.protocol },
          { label: t('traffic.fields.requested-model'), value: request.model },
          { label: t('traffic.fields.mapped-model'), value: request.mappedModel },
          { label: t('traffic.account'), value: request.attributedAccountId },
          { label: t('traffic.physical-model'), value: request.physicalModel },
          { label: t('traffic.model-family'), value: request.physicalModelFamily },
          {
            label: t('traffic.output-type'),
            value:
              request.hasTextOutput === null || request.hasImageOutput === null
                ? t('traffic.unknown')
                : request.hasTextOutput && request.hasImageOutput
                  ? t('traffic.mixed-output')
                  : request.hasImageOutput
                    ? t('traffic.image-output')
                    : request.hasTextOutput
                      ? t('traffic.text-output')
                      : t('traffic.no-visible-output'),
          },
          { label: t('traffic.fields.error'), value: request.error },
        ]}
      />
      <details className="mt-4 rounded-md border p-3 text-xs">
        <summary className="focus-visible:ring-ring cursor-default rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
          {t('traffic.advanced-diagnostics')}
        </summary>
        <div className="mt-3">
          <DefinitionList
            values={[
              { label: t('traffic.fields.request-id'), value: request.id },
              { label: t('traffic.session-key'), value: request.sessionId },
              { label: t('traffic.fields.client-address'), value: request.clientIp },
              { label: t('traffic.fields.username'), value: request.username },
              { label: t('traffic.fields.reasoning-tokens'), value: request.reasoningTokens },
              { label: t('traffic.fields.cached-tokens'), value: request.cachedTokens },
              { label: t('traffic.fields.query'), value: request.requestQuery },
            ]}
          />
        </div>
      </details>
      <details className="mt-4 rounded-md border p-3 text-xs">
        <summary className="cursor-default font-medium">{t('traffic.request-headers')}</summary>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap select-text">
          {request.requestHeaders}
        </pre>
      </details>
      {request.responseHeaders && (
        <details className="mt-2 rounded-md border p-3 text-xs">
          <summary className="cursor-default font-medium">{t('traffic.response-headers')}</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap select-text">
            {request.responseHeaders}
          </pre>
        </details>
      )}
    </section>
  );
}

function AttemptPane({
  attempts,
  parentId,
  onCopyCurl,
  selectedAttemptId,
  onSelect,
  borderless = false,
}: {
  attempts: RequestDetail['attempts'];
  parentId: string;
  onCopyCurl: (id: string, attemptId?: string) => void;
  selectedAttemptId: string | null;
  onSelect: (id: string) => void;
  borderless?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={`min-h-0 overflow-auto p-4 ${borderless ? '' : 'border-r'}`}>
      <h3 className="mb-3 text-sm font-semibold">{t('traffic.upstream-attempts')}</h3>
      <div className="space-y-2">
        {attempts.length === 0 && (
          <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
            {t('traffic.no-attempts')}
          </p>
        )}
        {attempts.map((attempt) => (
          <ContextMenu.Root key={attempt.id}>
            <ContextMenu.Trigger asChild>
              <button
                type="button"
                aria-pressed={selectedAttemptId === attempt.id}
                className={`focus-visible:ring-ring w-full cursor-default rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${selectedAttemptId === attempt.id ? 'border-foreground/40 bg-accent' : 'hover:bg-muted/50'}`}
                onClick={() => onSelect(attempt.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t('traffic.attempt', { index: attempt.attemptIndex })}
                  </span>
                  <OutcomeBadge outcome={attempt.outcome} />
                </div>
                <div className="text-muted-foreground mt-2 truncate text-xs">
                  {attempt.endpoint}
                </div>
                {attempt.accountId && (
                  <div className="mt-1 truncate font-mono text-[11px] select-text">
                    {attempt.accountId}
                  </div>
                )}
                <div className="text-muted-foreground mt-2 flex gap-3 text-[11px]">
                  <span>{attempt.status ?? '—'}</span>
                  <span>
                    {attempt.durationMs === null
                      ? t('traffic.running')
                      : `${attempt.durationMs} ms`}
                  </span>
                </div>
                {attempt.error && (
                  <div className="text-destructive mt-2 line-clamp-2 text-xs">{attempt.error}</div>
                )}
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="bg-popover text-popover-foreground z-50 min-w-48 rounded-md border p-1 shadow-md">
                <ContextMenu.Item
                  className="hover:bg-accent focus:bg-accent cursor-default rounded px-2 py-1.5 text-xs outline-none"
                  onSelect={() => onCopyCurl(parentId, attempt.id)}
                >
                  {t('traffic.copy-upstream-curl')}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ))}
      </div>
    </section>
  );
}

function PayloadPane({
  bodies,
  selectedBody,
  onSelect,
}: {
  bodies: TrafficAuditBodyDescriptor[];
  selectedBody: TrafficAuditBodyDescriptor | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-1.5">
        {bodies.map((body) => (
          <button
            key={body.id}
            type="button"
            aria-pressed={selectedBody?.id === body.id}
            className={`focus-visible:ring-ring cursor-default rounded-md border px-2.5 py-1.5 text-xs focus-visible:ring-2 focus-visible:outline-none ${selectedBody?.id === body.id ? 'border-foreground/40 bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
            onClick={() => onSelect(body.id)}
          >
            {body.ownerKind === 'parent' ? t('traffic.client') : t('traffic.upstream')}{' '}
            {t(`traffic.${body.direction}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="text-muted-foreground p-4 text-sm">{t('traffic.loading-records')}</div>
          }
        >
          <AuditBodyViewer body={selectedBody} />
        </Suspense>
      </div>
    </section>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useTranslation();
  const variant =
    outcome === 'completed' ? 'default' : outcome === 'in_progress' ? 'secondary' : 'destructive';
  return (
    <Badge
      variant={variant}
      className={`gap-1 text-[10px] font-medium ${outcome === 'completed' ? 'border-success-border bg-success-soft text-success hover:bg-success-soft' : ''}`}
    >
      {outcome === 'in_progress' ? <Clock3 className="h-3 w-3" /> : null}
      {outcome.includes('error') || outcome === 'partial' ? (
        <AlertTriangle className="h-3 w-3" />
      ) : null}
      {t(`traffic.outcomes.${outcome}`, { defaultValue: outcome })}
    </Badge>
  );
}

function DefinitionList({
  values,
}: {
  values: ReadonlyArray<{ label: string; value: string | number | null | undefined }>;
}) {
  return (
    <dl className="grid grid-cols-[minmax(90px,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
      {values.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground capitalize">{label}</dt>
          <dd className="min-w-0 font-mono wrap-break-word select-text">
            {value === null || value === undefined || value === '' ? '—' : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
