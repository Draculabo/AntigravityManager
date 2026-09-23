export type AuditJsonObject = { [key: string]: unknown };

/** Accept only JSON-style object shapes at provider payload boundaries. */
export function isAuditJsonObject(value: unknown): value is AuditJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function auditJsonObject(value: unknown): AuditJsonObject | null {
  return isAuditJsonObject(value) ? value : null;
}

export function parseAuditJsonBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) {
    return parseAuditJsonBody(body.toString('utf-8'));
  }
  if (typeof body !== 'string') {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
