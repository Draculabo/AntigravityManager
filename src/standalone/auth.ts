import crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map<string, { expiresAt: number }>();

function cleanupExpired() {
  const now = Date.now();
  for (const [token, info] of sessions) {
    if (info.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function getAdminPassword(): string {
  const value = process.env.AGM_ADMIN_PASSWORD?.trim();
  if (!value) {
    throw new Error('AGM_ADMIN_PASSWORD is not set');
  }
  return value;
}

export function verifyAdminPassword(candidate: string): boolean {
  const expected = getAdminPassword();
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function issueToken(): { token: string; expiresAt: number } {
  cleanupExpired();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  sessions.set(token, { expiresAt });
  return { token, expiresAt };
}

export function revokeToken(token: string): void {
  sessions.delete(token);
}

export function isTokenValid(token: string | null): boolean {
  if (!token) {
    return false;
  }
  cleanupExpired();
  const info = sessions.get(token);
  if (!info) {
    return false;
  }
  return info.expiresAt > Date.now();
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

const PUBLIC_PREFIXES = ['/api/health', '/api/auth/login', '/api/auth/info'];

function isPublicRoute(url: string): boolean {
  const pathOnly = url.split('?')[0];
  return PUBLIC_PREFIXES.some((p) => pathOnly === p);
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const url = req.url ?? '';
  if (!url.startsWith('/api/')) {
    return true;
  }
  if (isPublicRoute(url)) {
    return true;
  }
  const token = extractBearerToken(req);
  if (!isTokenValid(token)) {
    reply.status(401).send({ ok: false, error: 'Authentication required' });
    return false;
  }
  return true;
}
