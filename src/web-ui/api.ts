export interface AccountModelInfo {
  id: string;
  display_name: string | null;
  percentage: number | null;
  reset_time: string | null;
  max_output_tokens: number | null;
  supports_thinking: boolean;
  supports_images: boolean;
  recommended: boolean;
}

export interface AccountSummary {
  id: string;
  provider: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  status: string;
  status_reason: string | null;
  created_at: number;
  last_used: number;
  proxy_url: string | null;
  has_refresh_token: boolean;
  subscription_tier: string | null;
  ai_credits: { credits: number; expiryDate: string } | null;
  is_forbidden: boolean;
  models: AccountModelInfo[];
}

export interface ProxyStatus {
  running: boolean;
  port: number;
  base_url: string;
  active_accounts: number;
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const TOKEN_STORAGE_KEY = 'agm.token';

let memoryToken: string | null = null;

export const auth = {
  getToken(): string | null {
    if (memoryToken) return memoryToken;
    try {
      memoryToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      memoryToken = null;
    }
    return memoryToken;
  },
  setToken(token: string | null) {
    memoryToken = token;
    try {
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Ignored — the in-memory copy is enough for this session.
    }
  },
};

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  const token = auth.getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    auth.setToken(null);
    throw new UnauthorizedError();
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; timestamp: number }>('/api/health'),
  authInfo: () =>
    request<{ auth_required: boolean; proxy_api_key_set: boolean }>('/api/auth/info'),
  login: (password: string) =>
    request<{ ok: boolean; token: string; expires_at: number }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ ok: boolean }>('/api/auth/me'),
  proxyStatus: () => request<ProxyStatus>('/api/proxy/status'),
  proxyApiKey: () => request<{ api_key: string }>('/api/proxy/api-key'),
  startProxy: () => request<{ ok: boolean }>('/api/proxy/start', { method: 'POST' }),
  stopProxy: () => request<{ ok: boolean }>('/api/proxy/stop', { method: 'POST' }),
  listAccounts: () => request<{ accounts: AccountSummary[] }>('/api/accounts'),
  deleteAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refreshAccountQuota: (id: string) =>
    request<{ ok: boolean; account?: AccountSummary; error?: string }>(
      `/api/accounts/${encodeURIComponent(id)}/refresh-quota`,
      { method: 'POST' },
    ),
  oauthStart: () =>
    request<{ url: string; redirect_uri_hint: string }>('/api/oauth/start', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  oauthComplete: (input: { code?: string; redirect_url?: string }) =>
    request<{ ok: boolean; account?: AccountSummary; error?: string }>('/api/oauth/complete', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
