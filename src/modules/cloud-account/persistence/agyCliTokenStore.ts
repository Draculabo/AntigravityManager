import { logger } from '@/shared/logging/logger';
import { getAgyCliTokenPaths } from './agyCliTokenPaths';
import { writePrivateFileAtomically } from './privateCredentialFile';

const WSL_SHARE_HOST = 'wsl.localhost';

function getWslDistroFromTokenPath(target: string): string | null {
  const segments = target.split('\\').filter(Boolean);
  if (segments.length < 2 || segments[0].toLowerCase() !== WSL_SHARE_HOST) {
    return null;
  }

  return segments[1].toLowerCase();
}

function filterAmbiguousWslTokenTargets(targets: string[]): string[] {
  const targetsByDistro = new Map<string, string[]>();

  for (const target of targets) {
    const distro = getWslDistroFromTokenPath(target);
    if (!distro) {
      continue;
    }

    const distroTargets = targetsByDistro.get(distro) ?? [];
    distroTargets.push(target);
    targetsByDistro.set(distro, distroTargets);
  }

  const ambiguousDistros = new Set(
    Array.from(targetsByDistro.entries())
      .filter(([, distroTargets]) => distroTargets.length > 1)
      .map(([distro]) => distro),
  );

  for (const distro of ambiguousDistros) {
    logger.warn(
      `Skipping Antigravity CLI token sync for WSL distro ${distro}: multiple user sessions were discovered`,
    );
  }

  return targets.filter((target) => {
    const distro = getWslDistroFromTokenPath(target);
    return !distro || !ambiguousDistros.has(distro);
  });
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
  const targets = filterAmbiguousWslTokenTargets(getAgyCliTokenPaths());
  if (targets.length === 0) {
    logger.debug('No Antigravity CLI install found; skipping CLI token write');
    return;
  }

  for (const target of targets) {
    try {
      writePrivateFileAtomically(target, payload);
      logger.info(`Wrote Antigravity CLI token to ${target}`);
    } catch (error) {
      logger.warn(`Failed to write the Antigravity CLI token to ${target}`, error);
    }
  }
}
