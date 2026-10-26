import fs from 'node:fs';
import { z } from 'zod';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';

const LegacyThoughtSettingsSchema = z.object({
  proxy: z.object({
    thought_store: z.object({
      max_turns_per_session: z.number().int().min(1).max(10_000).optional(),
      max_disk_mib: z.number().int().min(128).max(16_384).optional(),
    }),
  }),
});

export function migratedThoughtTurnLimit(value: unknown): number | undefined {
  const parsed = LegacyThoughtSettingsSchema.safeParse(value);
  const turns = parsed.success ? parsed.data.proxy.thought_store.max_turns_per_session : undefined;
  return turns !== undefined && turns < 10 ? 10 : undefined;
}

function needsBackup(content: string): boolean {
  const value: unknown = JSON.parse(content);
  const parsed = LegacyThoughtSettingsSchema.safeParse(value);
  return (
    parsed.success &&
    (parsed.data.proxy.thought_store.max_disk_mib === undefined ||
      (parsed.data.proxy.thought_store.max_turns_per_session ?? 10) < 10)
  );
}

/** Configuration recovery only; the explicit schema-0/1 cache replacement is unchanged. */
export async function backupThoughtWindowMigration(configPath: string): Promise<void> {
  if (!fs.existsSync(configPath)) {
    return;
  }
  const existing = await fs.promises.readFile(configPath, 'utf8');
  if (!existing.trim() || !needsBackup(existing)) {
    return;
  }
  const backupPath = `${configPath}.pre-thought-window-migration.bak`;
  if (fs.existsSync(backupPath)) {
    if (!needsBackup(await fs.promises.readFile(backupPath, 'utf8'))) {
      throw new Error('Thought window configuration backup is invalid.');
    }
    return;
  }
  await writeFileAtomic(backupPath, existing);
}
