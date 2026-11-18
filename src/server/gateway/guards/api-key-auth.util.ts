import { isEmpty, isString } from 'lodash-es';
import type { IncomingHttpHeaders } from 'node:http';
export { hasConfiguredApiKey } from '@/shared/security/api-key';

export type RequestHeaderValue = IncomingHttpHeaders[string];

export type RequestHeaders = IncomingHttpHeaders;

export function extractApiKeyToken(headers: RequestHeaders): string | null {
  const authorizationHeader = readHeaderValue(headers['authorization']);
  if (authorizationHeader) {
    const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
    if (rest.length === 0 && token && scheme?.toLowerCase() === 'bearer') {
      return token;
    }
  }

  const xApiKeyHeader = readHeaderValue(headers['x-api-key']);
  if (xApiKeyHeader) {
    return xApiKeyHeader;
  }

  const xGoogApiKeyHeader = readHeaderValue(headers['x-goog-api-key']);
  if (xGoogApiKeyHeader) {
    return xGoogApiKeyHeader;
  }

  return null;
}

function readHeaderValue(headerValue: RequestHeaderValue): string | null {
  if (isString(headerValue)) {
    const trimmedValue = headerValue.trim();
    return !isEmpty(trimmedValue) ? trimmedValue : null;
  }

  if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      if (isString(value)) {
        const trimmedValue = value.trim();
        if (!isEmpty(trimmedValue)) {
          return trimmedValue;
        }
      }
    }
  }

  return null;
}
