import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { ConfigManager } from '../ipc/config/manager';
import { GoogleAPIService } from '../services/GoogleAPIService';
import { bootstrapNestServer, getNestServerStatus, stopNestServer } from '../server/main';
import { logger } from '../utils/logger';
import { CloudAccount } from '../types/cloudAccount';
import { AppConfigSchema } from '../types/config';
import {
  extractBearerToken,
  issueToken,
  isTokenValid,
  requireAuth,
  revokeToken,
  verifyAdminPassword,
} from './auth';

let app: FastifyInstance | null = null;

const OAuthStartBody = z.object({
  oauth_client_key: z.string().optional(),
});

const OAuthCompleteBody = z.object({
  // Either a raw code or the full localhost callback URL pasted by the user.
  code: z.string().optional(),
  redirect_url: z.string().optional(),
  oauth_client_key: z.string().optional(),
}).refine((value) => Boolean(value.code || value.redirect_url), {
  message: 'Provide `code` or `redirect_url`',
});

function extractCodeFromRedirectUrl(redirectUrl: string): string | null {
  try {
    const parsed = new URL(redirectUrl);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

function buildAccountSummary(account: CloudAccount) {
  const models = Object.entries(account.quota?.models ?? {}).map(([id, info]) => ({
    id: id.replace(/^models\//, ''),
    display_name: info.display_name ?? null,
    percentage: Number.isFinite(info.percentage) ? Math.round(info.percentage) : null,
    reset_time: info.resetTime || null,
    max_output_tokens: info.max_output_tokens ?? info.max_tokens ?? null,
    supports_thinking: Boolean(info.supports_thinking),
    supports_images: Boolean(info.supports_images),
    recommended: Boolean(info.recommended),
  }));

  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.name ?? null,
    avatar_url: account.avatar_url ?? null,
    status: account.status ?? 'active',
    status_reason: account.status_reason ?? null,
    created_at: account.created_at,
    last_used: account.last_used,
    proxy_url: account.proxy_url ?? null,
    has_refresh_token: Boolean(account.token?.refresh_token),
    subscription_tier: account.quota?.subscription_tier ?? null,
    ai_credits: account.quota?.ai_credits ?? null,
    is_forbidden: Boolean(account.quota?.is_forbidden ?? account.quota?.isForbidden),
    models,
  };
}

const LoginBody = z.object({
  password: z.string().min(1),
});

async function registerRoutes(instance: FastifyInstance) {
  instance.get('/api/health', async () => ({
    ok: true,
    timestamp: Date.now(),
  }));

  instance.get('/api/auth/info', async () => {
    const config = ConfigManager.loadConfig();
    return {
      auth_required: true,
      proxy_api_key_set: Boolean(config.proxy?.api_key?.trim()),
    };
  });

  instance.post('/api/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'Password required' };
    }
    if (!verifyAdminPassword(parsed.data.password)) {
      reply.status(401);
      return { ok: false, error: 'Invalid password' };
    }
    const { token, expiresAt } = issueToken();
    return { ok: true, token, expires_at: expiresAt };
  });

  instance.post('/api/auth/logout', async (req) => {
    const token = extractBearerToken(req);
    if (token) {
      revokeToken(token);
    }
    return { ok: true };
  });

  instance.get('/api/auth/me', async (req, reply) => {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) {
      reply.status(401);
      return { ok: false };
    }
    return { ok: true };
  });

  instance.get('/api/proxy/status', async () => getNestServerStatus());

  instance.post('/api/proxy/start', async () => {
    const config = ConfigManager.loadConfig();
    if (!config.proxy) {
      return { ok: false, error: 'No proxy config' };
    }
    const ok = await bootstrapNestServer(config.proxy);
    return { ok };
  });

  instance.post('/api/proxy/stop', async () => {
    const ok = await stopNestServer();
    return { ok };
  });

  instance.get('/api/config', async () => ConfigManager.loadConfig());

  instance.put('/api/config', async (req, reply) => {
    const parsed = AppConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid config payload',
      };
    }
    await ConfigManager.saveConfig(parsed.data);
    return { ok: true, config: parsed.data };
  });

  instance.get('/api/accounts', async () => {
    const accounts = await CloudAccountRepo.getAccounts();
    return { accounts: accounts.map(buildAccountSummary) };
  });

  instance.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req) => {
    await CloudAccountRepo.removeAccount(req.params.id);
    return { ok: true };
  });

  instance.post<{ Params: { id: string } }>(
    '/api/accounts/:id/refresh-quota',
    async (req, reply) => {
      const account = await CloudAccountRepo.getAccount(req.params.id);
      if (!account) {
        reply.status(404);
        return { ok: false, error: 'Account not found' };
      }
      try {
        const quota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );
        try {
          const credits = await GoogleAPIService.fetchAICredits(
            account.token.access_token,
            account.proxy_url,
          );
          if (credits) {
            quota.ai_credits = credits;
          }
        } catch (err) {
          logger.warn('[standalone] AI credits refresh failed', err);
        }
        await CloudAccountRepo.updateQuota(account.id, quota);
        const refreshed = await CloudAccountRepo.getAccount(account.id);
        return { ok: true, account: refreshed ? buildAccountSummary(refreshed) : null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Refresh failed';
        logger.warn('[standalone] Quota refresh failed', err);
        reply.status(502);
        return { ok: false, error: message };
      }
    },
  );

  instance.get('/api/proxy/api-key', async () => {
    const config = ConfigManager.loadConfig();
    return { api_key: config.proxy?.api_key ?? '' };
  });

  instance.post('/api/oauth/start', async (req) => {
    const parsed = OAuthStartBody.safeParse(req.body ?? {});
    const oauthClientKey = parsed.success ? parsed.data.oauth_client_key : undefined;
    const url = GoogleAPIService.getAuthUrl(oauthClientKey);
    return {
      url,
      redirect_uri_hint:
        'After consenting, your browser will be redirected to http://localhost:8888/oauth-callback?code=… — copy the full URL or the code value and submit it to /api/oauth/complete.',
    };
  });

  instance.post('/api/oauth/complete', async (req, reply) => {
    const parsed = OAuthCompleteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid payload' };
    }

    const { code: bodyCode, redirect_url: redirectUrl, oauth_client_key: oauthClientKey } =
      parsed.data;

    const code = bodyCode ?? (redirectUrl ? extractCodeFromRedirectUrl(redirectUrl) : null);
    if (!code) {
      reply.status(400);
      return { ok: false, error: 'Could not extract authorization code' };
    }

    try {
      const tokenResp = await GoogleAPIService.exchangeCode(code, undefined, oauthClientKey);
      const userInfo = await GoogleAPIService.getUserInfo(tokenResp.access_token);

      const existing = await CloudAccountRepo.getAccountByEmail(userInfo.email);
      if (existing) {
        reply.status(409);
        return { ok: false, error: `Account ${userInfo.email} already exists` };
      }

      const now = Math.floor(Date.now() / 1000);
      const account: CloudAccount = {
        id: uuidv4(),
        provider: 'google',
        email: userInfo.email,
        name: userInfo.name || userInfo.email,
        avatar_url: userInfo.picture,
        token: {
          access_token: tokenResp.access_token,
          refresh_token: tokenResp.refresh_token || '',
          expires_in: tokenResp.expires_in,
          expiry_timestamp: now + tokenResp.expires_in,
          token_type: tokenResp.token_type,
          email: userInfo.email,
          oauth_client_key: tokenResp.oauth_client_key,
          is_gcp_tos: false,
          id_token: tokenResp.id_token,
        },
        created_at: now,
        last_used: now,
      };

      await CloudAccountRepo.addAccount(account);

      try {
        const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
        account.quota = quota;
        await CloudAccountRepo.updateQuota(account.id, quota);
      } catch (err) {
        logger.warn('[standalone] Initial quota fetch failed', err);
      }

      return { ok: true, account: buildAccountSummary(account) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth exchange failed';
      logger.error('[standalone] OAuth complete failed', err);
      reply.status(400);
      return { ok: false, error: message };
    }
  });
}

function resolveWebUiDir(): string | null {
  const explicit = process.env.AGM_WEB_DIR?.trim();
  if (explicit && fs.existsSync(path.join(explicit, 'index.html'))) {
    return explicit;
  }
  const cwdCandidate = path.resolve(process.cwd(), 'dist-web');
  if (fs.existsSync(path.join(cwdCandidate, 'index.html'))) {
    return cwdCandidate;
  }
  return null;
}

function readMimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export async function startManagementServer(port: number): Promise<void> {
  if (app) {
    return;
  }

  const instance = Fastify({ logger: false });
  await instance.register(async (scope) => {
    scope.addHook('onRequest', (req, reply, done) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      if (req.method === 'OPTIONS') {
        reply.status(204).send();
        return;
      }
      if (!requireAuth(req, reply)) {
        return;
      }
      done();
    });
    await registerRoutes(scope);
  });

  const webDir = resolveWebUiDir();
  if (webDir) {
    logger.info(`[standalone] Serving web UI from ${webDir}`);
    instance.get('/*', (req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      const requested = req.url.split('?')[0];
      const candidate = requested === '/' ? '/index.html' : requested;
      const targetPath = path.normalize(path.join(webDir, candidate));
      if (!targetPath.startsWith(webDir)) {
        reply.status(403).send('Forbidden');
        return;
      }
      const finalPath = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()
        ? targetPath
        : path.join(webDir, 'index.html');
      reply.header('Content-Type', readMimeType(finalPath));
      reply.send(fs.readFileSync(finalPath));
    });
  } else {
    logger.info('[standalone] No dist-web build found; web UI not served from this port');
  }

  await instance.listen({ port, host: '0.0.0.0' });
  app = instance;
}

export async function stopManagementServer(): Promise<void> {
  if (!app) {
    return;
  }
  await app.close();
  app = null;
}
