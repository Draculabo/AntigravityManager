import { getAuditFileAdapter } from './audit-file-adapter';
import { SaveAuditBodyInputSchema } from '../audit/save-audit-body-input';
import { AuditFileOwnerError } from '../audit/audit-file-owner.schema';

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
