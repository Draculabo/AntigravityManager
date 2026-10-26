import type { TrafficAuditDetail } from './traffic-audit.types';
import type { AuditSessionSnapshot } from './audit-session-export.schema';

interface SessionExportSource {
  snapshot: (sessionId: string) => Promise<AuditSessionSnapshot>;
  detail: (id: string) => Promise<TrafficAuditDetail | null>;
  body: (id: string) => AsyncGenerator<string>;
}
const line = (value: object) => `${JSON.stringify(value)}\n`;

/** Full saved safe representations, streamed as versioned NDJSON within the file owner's byte cap. */
export async function* auditSessionForExport(
  sessionId: string,
  source: SessionExportSource,
): AsyncGenerator<string> {
  const initial = await source.snapshot(sessionId);
  yield line({
    kind: 'session',
    format: 'agm-audit-session',
    version: 1,
    sessionId,
    requestCount: initial.ids.length,
  });
  for (const id of initial.ids) {
    const detail = await source.detail(id);
    if (!detail || detail.recordKind !== 'request' || detail.request.sessionId !== sessionId) {
      throw new Error('Audit session record disappeared or changed during export');
    }
    yield line({ kind: 'request', detail });
    const emitted = new Set<string>();
    for (const body of detail.bodies) {
      if (emitted.has(body.id)) {
        continue;
      }
      emitted.add(body.id);
      yield line({ kind: 'body-start', bodyId: body.id });
      for await (const data of source.body(body.id)) {
        yield line({ kind: 'body-chunk', bodyId: body.id, data });
      }
      yield line({ kind: 'body-end', bodyId: body.id });
    }
  }
  const final = await source.snapshot(sessionId);
  if (final.fingerprint !== initial.fingerprint || final.ids.length !== initial.ids.length) {
    throw new Error('Audit session changed during export');
  }
  yield line({ kind: 'complete', requestCount: initial.ids.length });
}
