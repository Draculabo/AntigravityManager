import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const snapshotIndex = z.record(
  z.string(),
  z.object({ backup_file: z.string().min(1).optional() }).passthrough(),
);

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

async function resolveDestination(destination) {
  try {
    return await fs.realpath(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const entry = await fs.lstat(destination).catch((failure) => {
      if (failure.code !== 'ENOENT') {
        throw failure;
      }
      return undefined;
    });
    if (entry?.isSymbolicLink()) {
      throw new Error('fixture-snapshot-link-unresolved');
    }
    return path.join(
      await resolveDestination(path.dirname(destination)),
      path.basename(destination),
    );
  }
}

/** Cloned account indexes can retain absolute destinations in the original profile. */
export async function assertSnapshotIsolation(home) {
  const index = path.join(home, '.antigravity-agent', 'antigravity_accounts.json');
  const contents = await fs.readFile(index, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return '{}';
  });
  let decoded;
  try {
    decoded = JSON.parse(contents);
  } catch {
    throw new Error('fixture-snapshot-index-invalid');
  }
  const parsed = snapshotIndex.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('fixture-snapshot-index-invalid');
  }
  const backups = path.join(home, '.antigravity-agent', 'backups');
  const realHome = await fs.realpath(home);
  const realBackups = await resolveDestination(backups);
  if (!isWithin(realHome, realBackups)) {
    throw new Error('fixture-snapshot-outside-profile');
  }
  for (const { backup_file: destination } of Object.values(parsed.data)) {
    if (destination === undefined) {
      continue;
    }
    if (
      !path.isAbsolute(destination) ||
      !isWithin(backups, destination) ||
      !isWithin(realBackups, await resolveDestination(destination))
    ) {
      throw new Error('fixture-snapshot-outside-profile');
    }
  }
}
