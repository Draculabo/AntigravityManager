import { useEffect, useState, type FormEvent, type RefObject } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import { readFinalizedOperationDiagnostic } from '@/shared/observability/operationDiagnostic';
import {
  cancelOAuthSession,
  copyOAuthSessionLink,
  openOAuthSession,
  prepareOAuthSession,
  submitOAuthSessionCallback,
  waitForOAuthSession,
} from '../actions/cloud';
import { useOAuthClients, useSetActiveOAuthClient } from '../hooks/useCloudAccounts';
import { readDesktopOAuthLoginErrorCode } from '../services/desktop-oauth-login.schema';

function loginFailureDescription(error: unknown, t: TFunction): string {
  const loginCode = readDesktopOAuthLoginErrorCode(error) ?? 'login-failed';
  const diagnostic = readFinalizedOperationDiagnostic(error);
  if (
    diagnostic &&
    (diagnostic.accountCommit === 'confirmed' ||
      diagnostic.accountCommit === 'uncertain' ||
      ![
        'duplicate-account',
        'authorization-denied',
        'login-active',
        'login-cancelled',
        'invalid-manual-input',
      ].includes(loginCode))
  ) {
    return getLocalizedErrorMessage(error, t);
  }
  return t(`cloud.toast.addFailed.codes.${loginCode}`);
}

interface OAuthAttemptProps {
  clientKey: string;
  sessionQueueRef: RefObject<Promise<void>>;
  onAuthorized: (isCurrent: boolean) => void;
  onRestart: () => void;
}

type Attempt =
  | { kind: 'preparing' }
  | { kind: 'ready'; sessionId: string }
  | { kind: 'failed'; error: unknown };

function OAuthAttempt({ clientKey, sessionQueueRef, onAuthorized, onRestart }: OAuthAttemptProps) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState<Attempt>({ kind: 'preparing' });
  const [callback, setCallback] = useState('');
  const [action, setAction] = useState<'open' | 'copy' | 'submit'>();
  const [status, setStatus] = useState<'waiting' | 'copied'>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    let current = true;
    let sessionId: string | undefined;
    // A new attempt must wait for the previous listener to release its session.
    sessionQueueRef.current = sessionQueueRef.current.then(async () => {
      if (!current) {
        return;
      }
      try {
        const prepared = await prepareOAuthSession(clientKey);
        if (!current) {
          await cancelOAuthSession(prepared.sessionId);
          return;
        }
        sessionId = prepared.sessionId;
        setAttempt({ kind: 'ready', sessionId });
        void waitForOAuthSession(sessionId).then(
          () => onAuthorized(current),
          (error: unknown) => {
            if (current) {
              setAttempt({ kind: 'failed', error });
            }
          },
        );
      } catch (error) {
        if (current) {
          setAttempt({ kind: 'failed', error });
        }
      }
    });
    return () => {
      current = false;
      const previousId = sessionId;
      if (previousId) {
        sessionQueueRef.current = sessionQueueRef.current
          .then(() => cancelOAuthSession(previousId))
          .catch(() => undefined);
      }
    };
  }, [clientKey, onAuthorized, sessionQueueRef]);

  async function runAction(next: 'open' | 'copy' | 'submit') {
    if (attempt.kind !== 'ready' || action) {
      return;
    }
    const { sessionId } = attempt;
    setAction(next);
    setActionError(undefined);
    try {
      if (next === 'open') {
        await openOAuthSession(sessionId);
        setStatus('waiting');
      } else if (next === 'copy') {
        await copyOAuthSessionLink(sessionId);
        setStatus('copied');
      } else {
        await submitOAuthSessionCallback(sessionId, callback.trim());
        setCallback('');
        setStatus('waiting');
      }
    } catch (error) {
      setActionError(loginFailureDescription(error, t));
    } finally {
      setAction(undefined);
    }
  }

  function submitCallback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (callback.trim()) {
      void runAction('submit');
    }
  }

  if (attempt.kind === 'failed') {
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-destructive">
          {loginFailureDescription(attempt.error, t)}
        </p>
        <Button type="button" variant="outline" className="justify-self-start" onClick={onRestart}>
          {t('cloud.add-flow.retry-authorization')}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={attempt.kind === 'preparing' || Boolean(action)}
          onClick={() => void runAction('open')}
        >
          {attempt.kind === 'preparing' || action === 'open' ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <ExternalLink aria-hidden="true" className="size-4" />
          )}
          {t('cloud.authDialog.openLogin')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={attempt.kind === 'preparing' || Boolean(action)}
          onClick={() => void runAction('copy')}
        >
          <Copy aria-hidden="true" className="size-4" />
          {t('cloud.add-flow.copy-link')}
        </Button>
      </div>
      <p role="status" className="text-muted-foreground text-sm">
        {attempt.kind === 'preparing'
          ? t('cloud.add-flow.preparing-link')
          : status === 'copied'
            ? t('cloud.add-flow.link-copied')
            : status === 'waiting'
              ? t('cloud.authDialog.waiting-for-browser')
              : t('cloud.add-flow.browser-instructions')}
      </p>
      <details className="border-t pt-3">
        <summary className="focus-visible:ring-ring cursor-pointer rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
          {t('cloud.authDialog.manual-sign-in')}
        </summary>
        <form onSubmit={submitCallback} className="mt-3 grid gap-2">
          <Label htmlFor="add-account-callback">{t('cloud.add-flow.callback-label')}</Label>
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <Input
              id="add-account-callback"
              value={callback}
              disabled={attempt.kind === 'preparing' || Boolean(action)}
              onChange={(event) => {
                setCallback(event.target.value);
                setActionError(undefined);
              }}
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="add-account-callback-help"
              className="min-w-32 flex-1"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={attempt.kind === 'preparing' || Boolean(action) || !callback.trim()}
            >
              {t('cloud.add-flow.submit-callback')}
            </Button>
          </div>
          <p id="add-account-callback-help" className="text-muted-foreground text-xs">
            {t('cloud.add-flow.callback-help')}
          </p>
        </form>
      </details>
      {actionError && (
        <p role="alert" className="text-destructive text-sm">
          {actionError}
        </p>
      )}
    </div>
  );
}

type OAuthPanelProps = Pick<OAuthAttemptProps, 'sessionQueueRef' | 'onAuthorized'>;

export function CloudAccountOAuthPanel({ sessionQueueRef, onAuthorized }: OAuthPanelProps) {
  const { t } = useTranslation();
  const { data: clients = [], isPending } = useOAuthClients();
  const setActiveClient = useSetActiveOAuthClient();
  const [attemptNumber, setAttemptNumber] = useState(0);
  const active = clients.find((client) => client.is_active)?.key ?? '';

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="oauth-client-select">{t('cloud.authDialog.oauthClient')}</Label>
        <Select
          value={active}
          disabled={isPending || setActiveClient.isPending || clients.length < 2}
          onValueChange={(clientKey) => setActiveClient.mutate({ clientKey })}
        >
          <SelectTrigger id="oauth-client-select">
            <SelectValue placeholder={t('cloud.authDialog.oauthClientPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {clients.map((client) => (
              <SelectItem key={client.key} value={client.key}>
                {client.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {setActiveClient.isError && (
          <p role="alert" className="text-destructive">
            {t('cloud.toast.updateSettingsFailed')}
          </p>
        )}
      </div>
      {isPending || setActiveClient.isPending ? (
        <p role="status" className="text-muted-foreground">
          {t('cloud.add-flow.preparing-link')}
        </p>
      ) : (
        <OAuthAttempt
          key={`${active}:${attemptNumber}`}
          clientKey={active}
          sessionQueueRef={sessionQueueRef}
          onAuthorized={onAuthorized}
          onRestart={() => setAttemptNumber((number) => number + 1)}
        />
      )}
    </div>
  );
}
