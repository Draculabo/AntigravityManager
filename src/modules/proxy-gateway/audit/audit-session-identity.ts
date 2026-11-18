import type { FastifyRequest } from 'fastify';
import { resolveClientSessionHint } from '../../../server/gateway/common/client-session-hint';
import { resolveLineageAccountAffinity } from '../../../server/gateway/common/signature-session-scope';
import { auditJsonObject } from './audit-json-object';

/** Match D03's logical client session without persisting credentials or trusting response hints. */
export function resolveAuditSessionId(
  request: Pick<FastifyRequest, 'headers' | 'url' | 'body'>,
): string | undefined {
  const body = auditJsonObject(request.body);
  const hint = resolveClientSessionHint(
    request.headers,
    request.url,
    body ?? undefined,
    auditJsonObject(body?.metadata) ?? undefined,
  );
  return hint.id ? resolveLineageAccountAffinity(hint.id, request.headers) : undefined;
}
