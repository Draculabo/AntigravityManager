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
