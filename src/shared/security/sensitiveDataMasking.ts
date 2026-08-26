import { isObjectLike, isString } from 'lodash-es';

/**
 * Keys to mask in logs to avoid exposing sensitive data.
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'apikey',
  'api_key',
  'x-api-key',
  'x-goog-api-key',
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
const BASE64_REDACTED_PREFIX = '[base64 redacted';
const MIN_UNLABELED_BASE64_LENGTH = 512;
const DATA_URL_PATTERN = /data:(?<mime>[\w.+-]+\/[\w.+-]+);base64,(?<data>[A-Za-z0-9+/=]+)/g;
const URL_CREDENTIAL_PATTERN = /\b((?:https?|socks5?):\/\/)[^/\s]*@/gi;
const BASE64_FIELD_KEYS = new Set(['b64_json', 'base64', 'base64_data', 'base64data']);

function estimateBase64ByteLength(value: string): number {
  const normalized = value.replace(/\s+/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function summarizeBase64(value: string, mimeType?: string): string {
  const mimeSummary = mimeType ? ` mime=${mimeType}` : '';
  return `${BASE64_REDACTED_PREFIX}${mimeSummary} bytes=${estimateBase64ByteLength(value)}]`;
}

function isLikelyBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  return (
    normalized.length >= MIN_UNLABELED_BASE64_LENGTH &&
    normalized.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  );
}

function sanitizeString(value: string, key?: string, mimeType?: string): string {
  if (key && (BASE64_FIELD_KEYS.has(key.toLowerCase()) || isLikelyBase64(value))) {
    return summarizeBase64(value, mimeType);
  }

  if (!key && isLikelyBase64(value)) {
    return summarizeBase64(value, mimeType);
  }

  const withoutUrlCredentials = value.replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@');

  return withoutUrlCredentials.replace(DATA_URL_PATTERN, (...args: unknown[]) => {
    const groups = args.at(-1) as { mime?: string; data?: string } | undefined;
    if (!groups?.data) {
      return '[data URL redacted]';
    }
    return `[data URL redacted mime=${groups.mime ?? 'unknown'} bytes=${estimateBase64ByteLength(
      groups.data,
    )}]`;
  });
}

function resolveMimeType(obj: object): string | undefined {
  const record = obj as Record<string, unknown>;
  const value = record.mimeType ?? record.mime_type ?? record.content_type;
  return isString(value) ? value : undefined;
}

function sanitizeWithSeen(
  obj: unknown,
  seen: WeakSet<object>,
  key?: string,
  mimeType?: string,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (isString(obj)) {
    try {
      const parsed = JSON.parse(obj);
      if (isObjectLike(parsed)) {
        return JSON.stringify(sanitizeWithSeen(parsed, seen));
      }
    } catch {
      // Non-JSON strings can still contain inline binary payloads.
    }
    return sanitizeString(obj, key, mimeType);
  }

  if (Array.isArray(obj)) {
    if (seen.has(obj)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(obj);
    return obj.map((item) => sanitizeWithSeen(item, seen));
  }

  if (obj instanceof Error) {
    if (seen.has(obj)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(obj);
    return {
      name: obj.name,
      message: sanitizeWithSeen(obj.message, seen, 'message'),
      stack: sanitizeWithSeen(obj.stack, seen, 'stack'),
    };
  }

  if (isObjectLike(obj)) {
    if (seen.has(obj)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(obj);
    const sanitized: Record<string, unknown> = {};
    const objectMimeType = resolveMimeType(obj);
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeWithSeen(value, seen, key, objectMimeType);
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
    if (isObjectLike(value)) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}
