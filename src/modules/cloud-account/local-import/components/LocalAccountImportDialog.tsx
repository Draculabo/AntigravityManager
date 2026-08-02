import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  DatabaseZap,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import type { LocalAccountImportPreview, LocalAccountImportResult } from '../actions';
import { useLocalAccountImport } from '../hooks/useLocalAccountImport';

type DialogPhase = 'idle' | 'scanning' | 'preview' | 'importing' | 'result' | 'error';

const SOURCE_I18N_KEYS = {
  'antigravity-keyring': 'cloud.localImport.sources.antigravity-keyring',
  'antigravity-classic-db': 'cloud.localImport.sources.antigravity-classic-db',
  'antigravity-ide-db': 'cloud.localImport.sources.antigravity-ide-db',
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
      <div className="border-primary/30 bg-primary/5 flex items-start gap-3 rounded-md border p-3">
        <CheckCircle2 className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
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

export function LocalAccountImportDialog() {
  const { t } = useTranslation();
  const mutations = useLocalAccountImport();
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>('idle');
  const [preview, setPreview] = useState<LocalAccountImportPreview | null>(null);
  const [result, setResult] = useState<LocalAccountImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const generationRef = useRef(0);
  const isOpenRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const discardMutationRef = useRef(mutations.discard.mutateAsync);

  useEffect(() => {
    discardMutationRef.current = mutations.discard.mutateAsync;
  }, [mutations.discard.mutateAsync]);

  const discardSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await discardMutationRef.current({ sessionId });
    } catch {
      // The session is already bounded by its main-process TTL.
    }
  }, []);

  const resetView = () => {
    setPreview(null);
    setResult(null);
    setErrorMessage('');
    mutations.preview.reset();
    mutations.confirm.reset();
  };

  const startPreview = async (generation: number): Promise<void> => {
    setPhase('scanning');
    setErrorMessage('');
    try {
      const nextPreview = await mutations.preview.mutateAsync();
      if (!isOpenRef.current || generationRef.current !== generation) {
        await discardSession(nextPreview.sessionId);
        return;
      }
      activeSessionIdRef.current = nextPreview.sessionId;
      setPreview(nextPreview);
      setPhase('preview');
    } catch (error) {
      if (isOpenRef.current && generationRef.current === generation) {
        setErrorMessage(getImportErrorMessage(error, t));
        setPhase('error');
      }
    }
  };

  const closeDialog = () => {
    if (phase === 'importing') {
      return;
    }
    isOpenRef.current = false;
    generationRef.current += 1;
    setIsOpen(false);
    const sessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    if (sessionId) {
      discardSession(sessionId);
    }
    resetView();
    setPhase('idle');
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeDialog();
      return;
    }
    resetView();
    setIsOpen(true);
    isOpenRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startPreview(generation);
  };

  const handleRescan = () => {
    const previousSessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    if (previousSessionId) {
      discardSession(previousSessionId);
    }
    setPreview(null);
    setResult(null);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startPreview(generation);
  };

  const handleConfirm = async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !preview || preview.accounts.length === 0) {
      return;
    }
    const generation = generationRef.current;
    setPhase('importing');
    try {
      const importResult = await mutations.confirm.mutateAsync({ sessionId });
      activeSessionIdRef.current = null;
      if (isOpenRef.current && generationRef.current === generation) {
        setResult(importResult);
        setPhase('result');
      }
    } catch (error) {
      activeSessionIdRef.current = null;
      if (isOpenRef.current && generationRef.current === generation) {
        setErrorMessage(getImportErrorMessage(error, t));
        setPhase('error');
      }
    }
  };

  useEffect(() => {
    return () => {
      isOpenRef.current = false;
      generationRef.current += 1;
      const sessionId = activeSessionIdRef.current;
      activeSessionIdRef.current = null;
      if (sessionId) {
        discardSession(sessionId);
      }
    };
  }, [discardSession]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <DatabaseZap className="h-4 w-4" aria-hidden="true" />
          {t('cloud.localImport.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-[620px]"
        aria-busy={phase === 'scanning' || phase === 'importing'}
        onEscapeKeyDown={(event) => {
          if (phase === 'importing') {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (phase === 'importing') {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('cloud.localImport.title')}</DialogTitle>
          <DialogDescription>{t('cloud.localImport.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-32 py-2">
          {(phase === 'scanning' || phase === 'importing') && (
            <div
              className="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-3 text-sm"
              role="status"
              aria-live="polite"
            >
              <Loader2
                className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span>
                {phase === 'scanning'
                  ? t('cloud.localImport.scanning')
                  : t('cloud.localImport.importing')}
              </span>
            </div>
          )}
          {phase === 'preview' && preview && <PreviewContent preview={preview} />}
          {phase === 'result' && result && <ResultContent result={result} />}
          {phase === 'error' && (
            <div
              className="border-destructive/30 bg-destructive/5 flex min-h-32 flex-col items-center justify-center gap-3 rounded-md border p-5 text-center"
              role="alert"
            >
              <TriangleAlert className="text-destructive h-6 w-6" aria-hidden="true" />
              <p className="text-sm">{errorMessage}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === 'preview' && (
            <>
              <Button variant="outline" onClick={handleRescan}>
                <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                {t('cloud.localImport.rescan')}
              </Button>
              <Button variant="outline" onClick={closeDialog}>
                {t('cloud.localImport.cancel')}
              </Button>
              <Button
                onClick={() => {
                  void handleConfirm();
                }}
                disabled={!preview || preview.accounts.length === 0}
              >
                {t('cloud.localImport.confirm', { count: preview?.accounts.length ?? 0 })}
              </Button>
            </>
          )}
          {phase === 'scanning' && (
            <Button variant="outline" onClick={closeDialog}>
              {t('cloud.localImport.cancel')}
            </Button>
          )}
          {phase === 'error' && (
            <>
              <Button variant="outline" onClick={closeDialog}>
                {t('cloud.localImport.close')}
              </Button>
              <Button onClick={handleRescan}>
                <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                {t('cloud.localImport.rescan')}
              </Button>
            </>
          )}
          {phase === 'result' && (
            <Button onClick={closeDialog}>{t('cloud.localImport.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
