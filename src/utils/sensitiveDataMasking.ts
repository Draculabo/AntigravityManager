/**
 * Chiavi da mascherare nei log per evitare esposizione di dati sensibili
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'credentials',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'bearertoken',
  'bearer_token',
  'sessionid',
  'session_id',
  'cookie',
  'private_key',
  'privatekey',
  'client_secret',
  'clientsecret',
  'auth',
  'authcode',
  'auth_code',
  'code',
  'otp',
  'pin',
  'verificationcode',
  'verification_code',
];

/**
 * Sanitizza ricorsivamente un oggetto mascherando i valori dei campi sensibili
 */
export function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(sanitizeObject(parsed));
      }
    } catch {
      // Non JSON, restituisci invariato
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeObject(value);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Stringifica in modo sicuro un oggetto, gestendo riferimenti circolari e mascherando dati sensibili
 */
export function safeStringifyPacket(obj: unknown): string {
  const sanitized = sanitizeObject(obj);
  const seen = new WeakSet();
  return JSON.stringify(sanitized, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}
