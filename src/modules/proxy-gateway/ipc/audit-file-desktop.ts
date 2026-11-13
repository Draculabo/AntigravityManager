import { getAuditFileAdapter } from './audit-file-adapter';
import {
  SaveAuditBodyInputSchema,
  SaveAuditSessionInputSchema,
  SaveAuditHarInputSchema,
} from '../audit/save-audit-body-input';
import { AuditFileOwnerError } from '../audit/audit-file-owner.schema';

export async function exportSelectedAuditHar(
  requestId: string,
  suggestedName: string,
  selectPath: (safeName: string) => Promise<string | null>,
) {
  try {
    const [id, name] = SaveAuditHarInputSchema.parse([requestId, suggestedName]);
    const owner = getAuditFileAdapter();
    const safeName = name.replace(/[^a-z0-9._-]+/giu, '-').slice(0, 120);
    const filePath = await selectPath(safeName || `traffic-${id}.har`);
    if (!filePath) {
      return { status: 'cancelled' as const };
    }
    return await owner.exportHar({ requestId: id, filePath });
  } catch {
    throw new AuditFileOwnerError();
  }
}

export async function exportSelectedAuditSession(
  sessionId: string,
  suggestedName: string,
  selectPath: (safeName: string) => Promise<string | null>,
) {
  try {
    const [id, name] = SaveAuditSessionInputSchema.parse([sessionId, suggestedName]);
    const owner = getAuditFileAdapter();
    const safeName = name.replace(/[^a-z0-9._-]+/giu, '-').slice(0, 120);
    const filePath = await selectPath(safeName || 'traffic-session.ndjson');
    if (!filePath) {
      return { status: 'cancelled' as const };
    }
    return await owner.exportSession({ sessionId: id, filePath });
  } catch {
    throw new AuditFileOwnerError();
  }
}

/** Capture ownership before a file chooser can yield to an adapter reselection. */
export async function exportSelectedAuditBody(
  bodyId: string,
  suggestedName: string,
  selectPath: (safeName: string) => Promise<string | null>,
) {
  try {
    const [id, name] = SaveAuditBodyInputSchema.parse([bodyId, suggestedName]);
    const owner = getAuditFileAdapter();
    const safeName = name.replace(/[^a-z0-9._-]+/giu, '-').slice(0, 120);
    const filePath = await selectPath(safeName || `traffic-body-${id}.txt`);
    if (!filePath) {
      return { status: 'cancelled' as const };
    }
    return await owner.exportBody({ bodyId: id, filePath });
  } catch {
    throw new AuditFileOwnerError();
  }
}
