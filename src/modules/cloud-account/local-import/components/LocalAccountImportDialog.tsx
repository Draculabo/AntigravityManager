import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, RefreshCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { get, isString } from 'lodash-es';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import type { LocalAccountImportPreview, LocalAccountImportResult } from '../actions';
import { useLocalAccountImport } from '../hooks/useLocalAccountImport';

type ImportState =
  | { phase: 'idle' | 'scanning' | 'importing' }
  | { phase: 'preview'; preview: LocalAccountImportPreview }
  | { phase: 'result'; result: LocalAccountImportResult }
  | { phase: 'error'; message: string };

const SOURCE_I18N_KEYS = {
  'antigravity-keyring': 'cloud.localImport.sources.antigravity-keyring',
  'antigravity-classic-db': 'cloud.localImport.sources.antigravity-classic-db',
  'antigravity-ide-db': 'cloud.localImport.sources.antigravity-ide-db',
  'antigravity-agy-file': 'cloud.localImport.sources.antigravity-agy-file',
  'legacy-agent': 'cloud.localImport.sources.legacy-agent',
} as const;

const VALIDATION_ERROR_I18N_KEYS = {
  'credential-unavailable': 'cloud.localImport.validationErrors.credential-unavailable',
  'authentication-failed': 'cloud.localImport.validationErrors.authentication-failed',
  'network-failed': 'cloud.localImport.validationErrors.network-failed',
  'timed-out': 'cloud.localImport.validationErrors.timed-out',
  'unverified-email': 'cloud.localImport.validationErrors.unverified-email',
  'invalid-profile': 'cloud.localImport.validationErrors.invalid-profile',
} as const;

const DISCOVERY_ERROR_I18N_KEYS = {
  missing: 'cloud.localImport.discoveryErrors.missing',
  'permission-denied': 'cloud.localImport.discoveryErrors.permission-denied',
  locked: 'cloud.localImport.discoveryErrors.locked',
  malformed: 'cloud.localImport.discoveryErrors.malformed',
  'timed-out': 'cloud.localImport.discoveryErrors.timed-out',
  'read-failed': 'cloud.localImport.discoveryErrors.read-failed',
} as const;

const IMPORT_ERROR_I18N_KEYS = {
  'credential-unavailable': 'cloud.localImport.importErrors.credential-unavailable',
  'identity-required': 'cloud.localImport.importErrors.identity-required',
  'identity-conflict': 'cloud.localImport.importErrors.identity-conflict',
  'persistence-failed': 'cloud.localImport.importErrors.persistence-failed',
} as const;

const REQUEST_ERROR_I18N_KEYS = {
  'preview-failed': 'cloud.localImport.errors.preview-failed',
  'session-not-found': 'cloud.localImport.errors.session-not-found',
  'session-expired': 'cloud.localImport.errors.session-expired',
  'session-consumed': 'cloud.localImport.errors.session-consumed',
  'confirmation-failed': 'cloud.localImport.errors.confirmation-failed',
  'internal-error': 'cloud.localImport.errors.internal-error',
} as const;

function isRequestErrorCode(value: string): value is keyof typeof REQUEST_ERROR_I18N_KEYS {
  return Object.hasOwn(REQUEST_ERROR_I18N_KEYS, value);
}

function getSourceLabel(
  sourceId: LocalAccountImportPreview['sourceSummaries'][number]['id'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return t(SOURCE_I18N_KEYS[sourceId]);
}

function getImportErrorMessage(error: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  const code = get(error, 'data.localAccountImportErrorCode');
  if (isString(code) && isRequestErrorCode(code)) {
    return t(REQUEST_ERROR_I18N_KEYS[code]);
  }
  return getLocalizedErrorMessage(error, t);
}

function CountBadge({ label, count }: { label: string; count: number }) {
  return (
    <Badge variant="outline" className="font-normal">
      {label}: {count}
    </Badge>
  );
}

function PreviewContent({ preview }: { preview: LocalAccountImportPreview }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label={t('cloud.localImport.summary')}>
        <CountBadge label={t('cloud.localImport.accounts')} count={preview.accounts.length} />
        <CountBadge
          label={t('cloud.localImport.validationFailures')}
          count={preview.validationFailures.length}
        />
        <CountBadge
          label={t('cloud.localImport.discoveryFailures')}
          count={preview.discoveryFailures.length}
        />
        <CountBadge label={t('cloud.localImport.merged')} count={preview.merged.length} />
      </div>

      {preview.accounts.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-5 text-center text-sm">
          {t('cloud.localImport.noAccounts')}
        </div>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
          {preview.accounts.map((account) => (
            <div key={account.fingerprint} className="rounded-md border p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{account.identity.email}</p>
                  {account.identity.name && (
                    <p className="text-muted-foreground truncate text-xs">
                      {account.identity.name}
                    </p>
                  )}
                </div>
                <ShieldCheck className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {account.sources.map((source) => (
                  <Badge
                    key={`${source.id}:${source.location ?? ''}`}
                    variant="secondary"
                    className="max-w-full font-normal"
                    title={source.location}
                  >
                    <span className="truncate">{getSourceLabel(source.id, t)}</span>
                  </Badge>
                ))}
                {account.projectId && (
                  <Badge variant="outline" className="max-w-full font-normal">
                    <span className="truncate">
                      {t('cloud.localImport.project')}: {account.projectId}
                    </span>
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(preview.validationFailures.length > 0 ||
        preview.discoveryFailures.length > 0 ||
        preview.emailCollisionGroups.length > 0) && (
        <div className="border-destructive/30 bg-destructive/5 space-y-2 rounded-md border p-3">
          <div className="text-destructive flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {t('cloud.localImport.issues')}
          </div>
          <ul className="text-muted-foreground space-y-1 text-xs">
            {preview.validationFailures.map((failure) => (
              <li key={`${failure.fingerprint}:${failure.code}`}>
                {t(VALIDATION_ERROR_I18N_KEYS[failure.code], {
                  defaultValue: failure.message,
                })}
              </li>
            ))}
            {preview.discoveryFailures.map((failure, index) => (
              <li key={`${failure.source.id}:${failure.source.location ?? ''}:${index}`}>
                {getSourceLabel(failure.source.id, t)}:{' '}
                {t(DISCOVERY_ERROR_I18N_KEYS[failure.code], {
                  defaultValue: failure.message,
                })}
              </li>
            ))}
            {preview.emailCollisionGroups.map((group) => (
              <li key={group.email}>
                {t('cloud.localImport.emailCollision', {
                  email: group.email,
                  count: group.fingerprints.length,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ResultContent({ result }: { result: LocalAccountImportResult }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div
        className={`flex items-start gap-3 rounded-md border p-3 ${result.failed.length > 0 ? 'bg-warning-soft border-warning-border text-warning' : 'bg-success-soft border-success-border text-success'}`}
      >
        {result.failed.length > 0 ? (
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <div>
          <p className="font-medium">{t('cloud.localImport.resultTitle')}</p>
          <p className="text-muted-foreground text-sm">
            {t('cloud.localImport.resultDescription')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border p-3">
          <p className="text-lg font-semibold">{result.imported.length}</p>
          <p className="text-muted-foreground text-xs">
            {t('cloud.localImport.imported', { count: result.imported.length })}
          </p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-lg font-semibold">{result.skipped.length}</p>
          <p className="text-muted-foreground text-xs">
            {t('cloud.localImport.skipped', { count: result.skipped.length })}
          </p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-lg font-semibold">{result.failed.length}</p>
          <p className="text-muted-foreground text-xs">
            {t('cloud.localImport.failed', { count: result.failed.length })}
          </p>
        </div>
      </div>
      {result.failed.length > 0 && (
        <ul className="border-destructive/30 bg-destructive/5 text-muted-foreground max-h-32 space-y-1 overflow-y-auto rounded-md border p-3 text-xs">
          {result.failed.map((failure) => (
            <li key={`${failure.fingerprint}:${failure.code}`}>
              {failure.email ? `${failure.email}: ` : ''}
              {t(IMPORT_ERROR_I18N_KEYS[failure.code], {
                defaultValue: failure.message,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useImportPanel(onBusyChange?: (busy: boolean) => void) {
  const { t } = useTranslation();
  const mutations = useLocalAccountImport();
  const [state, setState] = useState<ImportState>({ phase: 'idle' });
  const generationRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const discardMutationRef = useRef(mutations.discard.mutateAsync);

  useEffect(() => {
    discardMutationRef.current = mutations.discard.mutateAsync;
  }, [mutations.discard.mutateAsync]);

  const discardSession = useCallback(async (sessionId: string) => {
    try {
      await discardMutationRef.current({ sessionId });
    } catch {
      // The session is already bounded by its main-process TTL.
    }
  }, []);

  const abandonPreview = useCallback(() => {
    generationRef.current += 1;
    const sessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    if (sessionId) {
      discardSession(sessionId);
    }
  }, [discardSession]);

  useEffect(() => abandonPreview, [abandonPreview]);

  const cancel = () => {
    abandonPreview();
    setState({ phase: 'idle' });
  };

  const scan = async () => {
    abandonPreview();
    const generation = generationRef.current;
    setState({ phase: 'scanning' });
    try {
      const preview = await mutations.preview.mutateAsync();
      if (generationRef.current !== generation) {
        await discardSession(preview.sessionId);
        return;
      }
      activeSessionIdRef.current = preview.sessionId;
      setState({ phase: 'preview', preview });
    } catch (error) {
      if (generationRef.current === generation) {
        setState({ phase: 'error', message: getImportErrorMessage(error, t) });
      }
    }
  };

  const confirm = async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || state.phase !== 'preview' || state.preview.accounts.length === 0) {
      return;
    }
    const generation = generationRef.current;
    activeSessionIdRef.current = null;
    onBusyChange?.(true);
    setState({ phase: 'importing' });
    try {
      const result = await mutations.confirm.mutateAsync({ sessionId });
      if (generationRef.current === generation) {
        setState({ phase: 'result', result });
      }
    } catch (error) {
      discardSession(sessionId);
      if (generationRef.current === generation) {
        setState({ phase: 'error', message: getImportErrorMessage(error, t) });
      }
    } finally {
      onBusyChange?.(false);
    }
  };

  return { state, scan, cancel, confirm };
}

function LocalImportStatus({ state }: { state: ImportState }) {
  const { t } = useTranslation();
  switch (state.phase) {
    case 'idle':
      return <p className="text-muted-foreground text-sm">{t('cloud.localImport.description')}</p>;
    case 'scanning':
    case 'importing':
      return (
        <div
          className="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-3 text-sm"
          role="status"
        >
          <Loader2
            className="text-primary size-6 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>
            {state.phase === 'scanning'
              ? t('cloud.localImport.scanning')
              : t('cloud.localImport.importing')}
          </span>
        </div>
      );
    case 'preview':
      return <PreviewContent preview={state.preview} />;
    case 'result':
      return <ResultContent result={state.result} />;
    case 'error':
      return (
        <div
          className="border-destructive/30 bg-destructive/5 flex min-h-32 flex-col items-center justify-center gap-3 rounded-md border p-5 text-center"
          role="alert"
        >
          <TriangleAlert className="text-destructive size-6" aria-hidden="true" />
          <p className="text-sm">{state.message}</p>
        </div>
      );
  }
}

function LocalImportActions({
  panel,
  onClose,
}: {
  panel: ReturnType<typeof useImportPanel>;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { state, scan, cancel, confirm } = panel;
  const close = onClose ?? cancel;
  switch (state.phase) {
    case 'idle':
      return <Button onClick={scan}>{t('cloud.localImport.scan')}</Button>;
    case 'scanning':
      return (
        <Button variant="outline" onClick={close}>
          {t('cloud.localImport.cancel')}
        </Button>
      );
    case 'importing':
      return null;
    case 'preview':
      return (
        <>
          <Button variant="outline" onClick={scan}>
            <RefreshCcw className="size-4" aria-hidden="true" />
            {t('cloud.localImport.rescan')}
          </Button>
          <Button variant="outline" onClick={close}>
            {t('cloud.localImport.cancel')}
          </Button>
          <Button onClick={confirm} disabled={state.preview.accounts.length === 0}>
            {t('cloud.localImport.confirm', { count: state.preview.accounts.length })}
          </Button>
        </>
      );
    case 'error':
    case 'result':
      return (
        <>
          {onClose && (
            <Button variant={state.phase === 'error' ? 'outline' : 'default'} onClick={onClose}>
              {t('cloud.localImport.close')}
            </Button>
          )}
          {(!onClose || state.phase === 'error') && (
            <Button onClick={scan}>
              <RefreshCcw className="size-4" aria-hidden="true" />
              {t('cloud.localImport.rescan')}
            </Button>
          )}
        </>
      );
  }
}

export function LocalAccountImportPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const panel = useImportPanel(onBusyChange);
  return (
    <div className="space-y-4">
      <LocalImportStatus state={panel.state} />
      {panel.state.phase !== 'importing' && (
        <div className="flex flex-wrap justify-end gap-2">
          <LocalImportActions panel={panel} />
        </div>
      )}
    </div>
  );
}

export interface LocalAccountImportDialogHandle {
  open: () => void;
}

export function LocalAccountImportDialog({
  ref,
  onCloseAutoFocus,
}: {
  ref: Ref<LocalAccountImportDialogHandle>;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const panel = useImportPanel();
  const [isOpen, setIsOpen] = useState(false);
  const { phase } = panel.state;
  const importing = phase === 'importing';

  useImperativeHandle(ref, () => ({
    open: () => {
      setIsOpen(true);
      panel.scan();
    },
  }));

  const closeDialog = () => {
    if (!importing) {
      panel.cancel();
      setIsOpen(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeDialog();
        }
      }}
    >
      <DialogContent
        className="flex max-w-[620px] flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={onCloseAutoFocus}
        closeDisabled={importing}
        onEscapeKeyDown={(event) => {
          if (importing) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (importing) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <DialogTitle>{t('cloud.localImport.title')}</DialogTitle>
          <DialogDescription>{t('cloud.localImport.description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {phase !== 'idle' && <LocalImportStatus state={panel.state} />}
        </div>
        {phase !== 'idle' && !importing && (
          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <LocalImportActions panel={panel} onClose={closeDialog} />
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
