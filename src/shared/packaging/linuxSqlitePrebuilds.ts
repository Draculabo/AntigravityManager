import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Keep the glibc prebuild in the staged module so RPM can strip the package on its target runner. */
export function pruneLinuxSqlitePrebuilds(stagedModule: string, arch: string): void {
  const prebuilds = path.join(stagedModule, 'prebuilds');
  const target = `linux-${arch}.node`;
  const missingTarget = `Missing staged better-sqlite3 prebuild: ${path.join(prebuilds, target)}`;

  if (
    !lstatSync(stagedModule, { throwIfNoEntry: false })?.isDirectory() ||
    !lstatSync(prebuilds, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error(missingTarget);
  }

  const entries = readdirSync(prebuilds, { withFileTypes: true });
  if (!entries.some((entry) => entry.name === target && entry.isFile())) {
    throw new Error(missingTarget);
  }

  for (const entry of entries) {
    if (entry.name !== target && entry.name.endsWith('.node')) {
      unlinkSync(path.join(prebuilds, entry.name));
    }
  }
}
