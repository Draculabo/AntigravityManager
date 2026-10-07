const LOCAL_USER_PATH_PATTERNS = [
  { pattern: /([A-Za-z]:\\Users\\)[^\\/\r\n]+/gi, replacement: '$1***' },
  { pattern: /([A-Za-z]:\/Users\/)[^/\r\n]+/gi, replacement: '$1***' },
  { pattern: /(\/Users\/)[^/\r\n]+/g, replacement: '$1***' },
  { pattern: /(\/home\/)[^/\r\n]+/g, replacement: '$1***' },
] as const;

export function redactLocalUserPaths(value: string): string {
  return LOCAL_USER_PATH_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    value,
  );
}

/** Readable diagnostic text must not reveal credentials embedded in errors or commands. */
export function redactDiagnosticText(text: string): string {
  return redactLocalUserPaths(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\b(go-keyring-base64:)[A-Za-z0-9+/=]+/g, '$1[REDACTED]')
    .replace(
      /([?&](?:access_token|refresh_token|id_token|api_key|key|client_secret|code)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(["']?\b(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|x-api-key|x-goog-api-key|client[_-]?secret|password|authorization|cookie|session[_-]?id|auth[_-]?code|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b((?:https?|socks5?):\/\/)[^/\s]*@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]');
}

export function redactSentryEventLocalPaths(value: unknown): void {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return redactLocalUserPaths(current);
    }

    if (Array.isArray(current)) {
      if (seen.has(current)) {
        return current;
      }
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        current[index] = visit(current[index]);
      }
      return current;
    }

    if (current && typeof current === 'object') {
      if (seen.has(current)) {
        return current;
      }
      seen.add(current);
      const record = current as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) {
        record[key] = visit(child);
      }
    }

    return current;
  };

  visit(value);
}
