import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  auth,
  AccountModelInfo,
  AccountSummary,
  ProxyStatus,
  UnauthorizedError,
} from './api';

type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: string };

function relativeTime(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatResetTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'available';
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours > 24) {
    return `resets in ${Math.floor(hours / 24)}d`;
  }
  if (hours > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }
  return `resets in ${minutes}m`;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
      : status === 'rate_limited'
        ? 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
        : 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ring-1 ${tone}`}>
      {status}
    </span>
  );
}

function QuotaBar({ percentage }: { percentage: number | null }) {
  const value = percentage ?? 0;
  const tone =
    value >= 60
      ? 'bg-emerald-500'
      : value >= 25
        ? 'bg-amber-500'
        : value > 0
          ? 'bg-rose-500'
          : 'bg-slate-700';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function ModelsTable({ models }: { models: AccountModelInfo[] }) {
  if (models.length === 0) {
    return (
      <p className="mt-2 text-xs text-slate-500">
        No quota data yet — try refreshing this account.
      </p>
    );
  }
  return (
    <table className="mt-3 w-full text-xs">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="pb-2 font-medium">Model</th>
          <th className="pb-2 font-medium">Quota</th>
          <th className="pb-2 font-medium">Reset</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-800/60 text-slate-300">
        {models.map((model) => {
          const reset = formatResetTime(model.reset_time);
          return (
            <tr key={model.id}>
              <td className="py-2 pr-3 align-top">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-slate-200">
                    {model.display_name ?? model.id}
                  </span>
                  {model.recommended ? (
                    <span className="rounded bg-indigo-500/15 px-1 py-px text-[10px] text-indigo-300 ring-1 ring-indigo-500/30">
                      rec
                    </span>
                  ) : null}
                  {model.supports_thinking ? (
                    <span className="rounded bg-slate-800 px-1 py-px text-[10px] text-slate-400">
                      think
                    </span>
                  ) : null}
                </div>
                {model.display_name && model.display_name !== model.id ? (
                  <div className="font-mono text-[10px] text-slate-500">{model.id}</div>
                ) : null}
              </td>
              <td className="w-44 py-2 pr-3 align-top">
                <div className="flex items-center gap-2">
                  <QuotaBar percentage={model.percentage} />
                  <span className="w-9 text-right font-mono text-[11px] text-slate-300">
                    {model.percentage ?? '–'}%
                  </span>
                </div>
              </td>
              <td className="py-2 align-top text-slate-400">{reset ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProxyPanel({
  status,
  apiKey,
  refresh,
}: {
  status: ProxyStatus | null;
  apiKey: string | null;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const onToggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (status?.running) {
        await api.stopProxy();
      } else {
        await api.startProxy();
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }, [status?.running, refresh]);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">OpenAI/Anthropic Proxy</h2>
          <p className="mt-1 text-sm text-slate-400">
            Point your client's <code className="text-slate-200">base_url</code> at the address
            below.
          </p>
        </div>
        <button
          onClick={onToggle}
          disabled={busy}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 ring-1 ring-slate-700 hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? '…' : status?.running ? 'Stop' : 'Start'}
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">State</dt>
          <dd className="mt-1 text-sm text-slate-100">
            {status ? (status.running ? 'Running' : 'Stopped') : '…'}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Base URL</dt>
          <dd className="mt-1 break-all text-sm text-slate-100">
            {status?.base_url || `http://localhost:${status?.port || '?'}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Active accounts</dt>
          <dd className="mt-1 text-sm text-slate-100">{status?.active_accounts ?? 0}</dd>
        </div>
      </dl>

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Authorization (clients send via Bearer / x-api-key)
          </span>
          {apiKey ? (
            <button
              onClick={() => setRevealed((v) => !v)}
              className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700"
            >
              {revealed ? 'hide' : 'reveal'}
            </button>
          ) : null}
        </div>
        <div className="mt-1 break-all font-mono text-sm text-slate-200">
          {apiKey
            ? revealed
              ? apiKey
              : '•'.repeat(Math.min(apiKey.length, 32))
            : 'open mode — set AGM_API_KEY in .env to require auth'}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
    </section>
  );
}

function AddAccountPanel({ onAdded }: { onAdded: () => void }) {
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const onStart = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.oauthStart();
      setAuthUrl(result.url);
      setHint(result.redirect_uri_hint);
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }, []);

  const onComplete = useCallback(async () => {
    if (!pasted.trim()) {
      setMessage({ kind: 'err', text: 'Paste the callback URL or code first' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const isUrl = pasted.trim().toLowerCase().startsWith('http');
      const payload = isUrl ? { redirect_url: pasted.trim() } : { code: pasted.trim() };
      const result = await api.oauthComplete(payload);
      if (result.ok && result.account) {
        setMessage({
          kind: 'ok',
          text: `Added ${result.account.email}`,
        });
        setPasted('');
        setAuthUrl(null);
        onAdded();
      } else {
        setMessage({ kind: 'err', text: result.error ?? 'Unknown error' });
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }, [pasted, onAdded]);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-base font-semibold text-slate-100">Add Google account</h2>
      <p className="mt-1 text-sm text-slate-400">
        Sign in on your own machine, then paste the localhost callback URL back here.
      </p>

      <ol className="mt-4 space-y-4 text-sm text-slate-300">
        <li>
          <button
            onClick={onStart}
            disabled={busy}
            className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-400 disabled:opacity-50"
          >
            1. Get sign-in URL
          </button>
          {authUrl ? (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-3 break-all text-indigo-300 underline"
            >
              Open in new tab
            </a>
          ) : null}
          {hint ? <p className="mt-2 text-xs text-slate-400">{hint}</p> : null}
        </li>
        <li>
          <label className="block">
            <span className="text-sm font-medium text-slate-200">
              2. Paste the redirected URL or just the code
            </span>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="http://localhost:8888/oauth-callback?code=4/0AeaY…"
              rows={3}
              className="mt-2 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
            />
          </label>
          <button
            onClick={onComplete}
            disabled={busy || !pasted.trim()}
            className="mt-3 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? 'Adding…' : '3. Add account'}
          </button>
        </li>
      </ol>

      {message ? (
        <p
          className={`mt-3 text-sm ${
            message.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function AccountRow({
  account,
  onRemove,
  onRefreshed,
}: {
  account: AccountSummary;
  onRemove: () => void;
  onRefreshed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credits = account.ai_credits;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await api.refreshAccountQuota(account.id);
      if (!result.ok) {
        setError(result.error ?? 'Failed');
      }
      onRefreshed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRefreshing(false);
    }
  }, [account.id, onRefreshed]);

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        {account.avatar_url ? (
          <img
            src={account.avatar_url}
            alt=""
            className="h-8 w-8 rounded-full ring-1 ring-slate-700"
          />
        ) : (
          <div className="h-8 w-8 rounded-full bg-slate-700" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-100">{account.email}</span>
            <StatusBadge status={account.status} />
            {account.subscription_tier ? (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 ring-1 ring-slate-700">
                {account.subscription_tier}
              </span>
            ) : null}
            {!account.has_refresh_token ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300 ring-1 ring-amber-500/30">
                no refresh
              </span>
            ) : null}
            {account.is_forbidden ? (
              <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-300 ring-1 ring-rose-500/30">
                forbidden
              </span>
            ) : null}
          </div>
          <div className="text-xs text-slate-400">
            added {relativeTime(account.created_at)} · {account.models.length} models
            {credits ? ` · ${credits.credits} credits` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700 disabled:opacity-50"
          >
            {refreshing ? '…' : 'Refresh'}
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700"
          >
            {open ? 'Hide' : 'Quota'}
          </button>
          <button
            onClick={onRemove}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-rose-500/20 hover:text-rose-200"
          >
            Remove
          </button>
        </div>
      </div>

      {open ? <ModelsTable models={account.models} /> : null}
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
    </li>
  );
}

function AccountsPanel({
  accounts,
  loading,
  onChanged,
}: {
  accounts: AccountSummary[];
  loading: boolean;
  onChanged: () => void;
}) {
  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm('Remove this account from the pool?')) return;
      try {
        await api.deleteAccount(id);
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed');
      }
    },
    [onChanged],
  );

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-100">Accounts ({accounts.length})</h2>
        {loading ? <span className="text-xs text-slate-500">refreshing…</span> : null}
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-slate-400">
          No accounts yet. Add one above to start serving requests.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onRemove={() => onDelete(account.id)}
              onRefreshed={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!password) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.login(password);
        auth.setToken(result.token);
        setPassword('');
        onLoggedIn();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed');
      } finally {
        setBusy(false);
      }
    },
    [password, onLoggedIn],
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-950 to-slate-900 px-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl"
      >
        <h1 className="text-lg font-semibold text-slate-100">Antigravity Manager</h1>
        <p className="mt-1 text-sm text-slate-400">Enter the admin password to continue.</p>
        <label className="mt-5 block">
          <span className="text-xs uppercase tracking-wide text-slate-500">Password</span>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
          />
        </label>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          The password is whatever you put in <code>AGM_ADMIN_PASSWORD</code>.
        </p>
      </form>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(auth.getToken()));
  const [accountsState, setAccountsState] = useState<LoadState<AccountSummary[]>>({
    status: 'idle',
  });
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [proxyApiKey, setProxyApiKey] = useState<string | null>(null);

  const handleAuthError = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) {
      setAuthed(false);
      return true;
    }
    return false;
  }, []);

  const reloadAccounts = useCallback(async () => {
    setAccountsState((s) => (s.status === 'ok' ? s : { status: 'loading' }));
    try {
      const result = await api.listAccounts();
      setAccountsState({ status: 'ok', data: result.accounts });
    } catch (err) {
      if (handleAuthError(err)) return;
      setAccountsState({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed',
      });
    }
  }, [handleAuthError]);

  const reloadProxy = useCallback(async () => {
    try {
      const [status, key] = await Promise.all([api.proxyStatus(), api.proxyApiKey()]);
      setProxy(status);
      setProxyApiKey(key.api_key || null);
    } catch (err) {
      if (handleAuthError(err)) return;
    }
  }, [handleAuthError]);

  const reloadAll = useCallback(() => {
    reloadAccounts();
    reloadProxy();
  }, [reloadAccounts, reloadProxy]);

  useEffect(() => {
    if (!authed) return;
    reloadAll();
    const id = setInterval(reloadAll, 10_000);
    return () => clearInterval(id);
  }, [authed, reloadAll]);

  const onLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore — we're clearing the session anyway
    }
    auth.setToken(null);
    setAuthed(false);
    setAccountsState({ status: 'idle' });
    setProxy(null);
    setProxyApiKey(null);
  }, []);

  const accounts = useMemo(
    () => (accountsState.status === 'ok' ? accountsState.data : []),
    [accountsState],
  );
  const loading = accountsState.status === 'loading';

  if (!authed) {
    return <LoginScreen onLoggedIn={() => setAuthed(true)} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">
            Antigravity Manager <span className="text-slate-400">Web</span>
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={reloadAll}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700"
            >
              Refresh
            </button>
            <button
              onClick={onLogout}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm text-slate-200 ring-1 ring-slate-700 hover:bg-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-6 py-8">
        <ProxyPanel status={proxy} apiKey={proxyApiKey} refresh={reloadProxy} />
        <AddAccountPanel onAdded={reloadAccounts} />
        <AccountsPanel accounts={accounts} loading={loading} onChanged={reloadAccounts} />
        {accountsState.status === 'error' ? (
          <p className="text-sm text-rose-300">Failed to load accounts: {accountsState.error}</p>
        ) : null}
      </main>
    </div>
  );
}
