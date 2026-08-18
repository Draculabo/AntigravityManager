import fs from 'fs';
import { logger } from '@/shared/logging/logger';
import { getAgyCliTokenPaths } from '@/shared/platform/paths';

function writeTokenFile(target: string, payload: string): void {
  const tempPath = `${target}.agm-tmp`;
  try {
    fs.writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, target);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write/replace failure.
    }
    throw error;
  }
}

/**
 * Puts the active account into the Antigravity CLI (`agy`) session file.
 *
 * The IDE reads its token from the system credential store, but the CLI reads
 * the very same payload from a file, so an account switch that only touches
 * the credential store leaves the CLI signed in as somebody else. The payload
 * is passed in already built to guarantee both stay byte-identical.
 *
 * Every target is best-effort: a CLI install that cannot be written must not
 * fail the switch the IDE already accepted.
 */
export function writeAgyCliToken(payload: string): void {
  const targets = getAgyCliTokenPaths();
  if (targets.length === 0) {
    logger.debug('No Antigravity CLI install found; skipping CLI token write');
    return;
  }

  for (const target of targets) {
    try {
      writeTokenFile(target, payload);
      logger.info(`Wrote Antigravity CLI token to ${target}`);
    } catch (error) {
      logger.warn(`Failed to write the Antigravity CLI token to ${target}`, error);
    }
  }
}
