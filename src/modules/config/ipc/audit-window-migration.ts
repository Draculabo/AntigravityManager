import fs from 'node:fs';
import { z } from 'zod';

import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';

const LegacyAuditSettings = z.object({
  proxy: z.object({
    traffic_audit: z.object({
      body_retention_hours: z.unknown().optional(),
      summary_retention_days: z.unknown().optional(),
    }),
  }),
});

function hasAgeSettings(content: string): boolean {
  const value: unknown = JSON.parse(content);
  const parsed = LegacyAuditSettings.safeParse(value);
  return (
    parsed.success &&
    (Object.hasOwn(parsed.data.proxy.traffic_audit, 'body_retention_hours') ||
      Object.hasOwn(parsed.data.proxy.traffic_audit, 'summary_retention_days'))
  );
}

/** Called inside the config owner's serialized save, before retiring durable age settings. */
export async function backupAuditWindowMigration(configPath: string): Promise<void> {
  if (!fs.existsSync(configPath)) {
    return;
  }
  const existing = await fs.promises.readFile(configPath, 'utf8');
  if (existing.trim() === '' || !hasAgeSettings(existing)) {
    return;
  }
  const backupPath = `${configPath}.pre-audit-window-migration.bak`;
  if (fs.existsSync(backupPath)) {
    // A directory or corrupt snapshot must not masquerade as a successful recovery copy.
    if (!hasAgeSettings(await fs.promises.readFile(backupPath, 'utf8'))) {
      throw new Error('Audit window configuration backup is invalid.');
    }
    return;
  }
  await writeFileAtomic(backupPath, existing);
}
