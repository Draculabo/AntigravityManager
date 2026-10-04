import { clipboard } from 'electron';
import type { CopyAuditCurlInput } from './build-audit-curl';
import { getAuditCurlAdapter } from '../ipc/audit-curl-adapter';
import {
  AuditCurlInputSchema,
  AuditCurlOpenSchema,
  AuditCurlOwnerError,
  curlResourceId,
} from './audit-curl-owner.schema';
import { readDiagnosticContent } from '../diagnostics/read-content';

export type { CopyAuditCurlInput } from './build-audit-curl';

export async function copyAuditCurl(input: CopyAuditCurlInput): Promise<void> {
  const owner = getAuditCurlAdapter();
  try {
    const parsed = AuditCurlInputSchema.parse(input);
    const descriptor = AuditCurlOpenSchema.parse(await owner.open(parsed));
    if (descriptor.resourceId !== curlResourceId(parsed)) {
      throw new AuditCurlOwnerError();
    }
    const bytes = await readDiagnosticContent(owner, descriptor);
    clipboard.writeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AuditCurlOwnerError();
  }
}
