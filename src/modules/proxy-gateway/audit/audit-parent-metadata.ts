import { snapshotAuditPayload } from './audit-sanitizer';

export function serializeAuditError(error: unknown): string | null {
  if (error === undefined || error === null) {
    return null;
  }
  return snapshotAuditPayload(
    error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : error,
  ).text;
}
export function extractAuditModel(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const model = Reflect.get(body, 'model');
  if (typeof model === 'string') {
    return model;
  }
  const nested = Reflect.get(body, 'request');
  return nested && typeof nested === 'object' && typeof Reflect.get(nested, 'model') === 'string'
    ? String(Reflect.get(nested, 'model'))
    : null;
}
