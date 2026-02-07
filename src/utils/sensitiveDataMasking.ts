/**
 * Keys to mask in logs to avoid exposing sensitive data.
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

const CIRCULAR_PLACEHOLDER = '[Circular]';

function sanitizeWithSeen(obj: unknown, seen: WeakSet<object>): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    try {
      const parsed = JSON.parse(obj);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(sanitizeWithSeen(parsed, seen));
      }
    } catch {
      // Not JSON, return unchanged
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (seen.has(obj)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(obj);
    return obj.map((item) => sanitizeWithSeen(item, seen));
  }

  if (typeof obj === 'object') {
    if (seen.has(obj)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(obj);
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeWithSeen(value, seen);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Recursively sanitizes an object by masking sensitive field values.
 * Handles circular references by replacing them with '[Circular]'.
 */
export function sanitizeObject(obj: unknown): unknown {
  return sanitizeWithSeen(obj, new WeakSet());
}

/**
 * Safely stringifies an object, handling circular references and masking sensitive data.
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
