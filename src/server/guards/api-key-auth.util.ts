import { isEmpty, isString } from 'lodash-es';

export type RequestHeaderValue = string | string[] | undefined;

export type RequestHeaders = Record<string, RequestHeaderValue>;

export function hasConfiguredApiKey(apiKey: string | undefined): apiKey is string {
  return isString(apiKey) && !isEmpty(apiKey.trim());
}

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
