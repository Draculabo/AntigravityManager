import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/shared/logging/logger';
import { getAntigravityExtensionsDir, getAntigravityHostUserDir } from '@/shared/platform/paths';

function isPreservedPhysicalPath(targetPath: string): boolean {
  return !isPathAbsent(targetPath) && !fs.lstatSync(targetPath).isSymbolicLink();
}
export function isPathAbsent(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return false;
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Creates an idempotent, cross-platform resilient symlink.
 * - Uses NTFS directory junctions ('junction') on Windows for directories.
 * - Falls back to copyFileSync for files on Windows if file symlinks require Developer Mode / admin privilege.
 * - Removes stale or broken symlinks before recreating.
 * - Preserves existing physical files and directories in the profile (never overwrites).
 * - Catches all errors defensively and logs warnings, guaranteeing IDE startup is never blocked.
 */
export function safeSymlink(src: string, dest: string, type: 'file' | 'dir'): boolean {
  try {
    if (!fs.existsSync(src)) {
      return false;
    }

    try {
      const stats = fs.lstatSync(dest);
      if (stats.isSymbolicLink()) {
        try {
          const currentTarget = fs.readlinkSync(dest);
          const resolvedCurrent = path.resolve(path.dirname(dest), currentTarget);
          const resolvedSrc = path.resolve(src);
          if (resolvedCurrent === resolvedSrc) {
            return true; // Already correctly linked
          }
          fs.unlinkSync(dest);
        } catch {
          fs.unlinkSync(dest);
        }
      } else {
        // A regular file or directory already exists in profile; do not overwrite
        return false;
      }
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code !== 'ENOENT'
      ) {
        logger.warn(`Could not inspect destination path "${dest}":`, err);
        return false;
      }
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (process.platform === 'win32') {
      if (type === 'dir') {
        fs.symlinkSync(src, dest, 'junction');
        return true;
      }
      try {
        fs.symlinkSync(src, dest, 'file');
        return true;
      } catch {
        fs.copyFileSync(src, dest);
        return true;
      }
    } else {
      fs.symlinkSync(src, dest, type);
      return true;
    }
  } catch (error) {
    logger.warn(`safeSymlink failed linking "${src}" to "${dest}":`, error);
    return false;
  }
}

export function provisionEditorSettings(profileUserDataDir: string, hostUserDir?: string): boolean {
  let complete = true;
  try {
    const effectiveHostUserDir = hostUserDir ?? getAntigravityHostUserDir();
    if (!fs.existsSync(effectiveHostUserDir)) {
      return true;
    }

    const profileUserDir = path.join(profileUserDataDir, 'User');
    if (path.resolve(effectiveHostUserDir) === path.resolve(profileUserDir)) {
      return true;
    }

    fs.mkdirSync(profileUserDir, { recursive: true });

    // File settings
    const filesToShare = ['settings.json', 'keybindings.json'];
    for (const file of filesToShare) {
      const src = path.join(effectiveHostUserDir, file);
      const dest = path.join(profileUserDir, file);
      if (fs.existsSync(src)) {
        complete = (safeSymlink(src, dest, 'file') || isPreservedPhysicalPath(dest)) && complete;
      }
    }

    // Directory settings (snippets)
    const dirsToShare = ['snippets'];
    for (const dir of dirsToShare) {
      const src = path.join(effectiveHostUserDir, dir);
      const dest = path.join(profileUserDir, dir);
      if (fs.existsSync(src)) {
        complete = (safeSymlink(src, dest, 'dir') || isPreservedPhysicalPath(dest)) && complete;
      }
    }
  } catch (err) {
    logger.warn('Defensive error in provisionEditorSettings', err);
    return false;
  }
  return complete;
}

export function provisionExtensionsSharing(
  profileUserDataDir: string,
  isolatedHome: string,
  hostExtensionsDir?: string,
): boolean {
  let complete = true;
  try {
    const effectiveHostExtensionsDir = hostExtensionsDir ?? getAntigravityExtensionsDir();
    if (!fs.existsSync(effectiveHostExtensionsDir)) {
      return true;
    }

    const destProfileExtensions = path.join(profileUserDataDir, 'extensions');
    if (path.resolve(effectiveHostExtensionsDir) !== path.resolve(destProfileExtensions)) {
      complete =
        (safeSymlink(effectiveHostExtensionsDir, destProfileExtensions, 'dir') ||
          isPreservedPhysicalPath(destProfileExtensions)) &&
        complete;
    }

    const destIsolatedHomeExtensions = path.join(isolatedHome, '.antigravity', 'extensions');
    if (path.resolve(effectiveHostExtensionsDir) !== path.resolve(destIsolatedHomeExtensions)) {
      complete =
        (safeSymlink(effectiveHostExtensionsDir, destIsolatedHomeExtensions, 'dir') ||
          isPreservedPhysicalPath(destIsolatedHomeExtensions)) &&
        complete;
    }
  } catch (err) {
    logger.warn('Defensive error in provisionExtensionsSharing', err);
    return false;
  }
  return complete;
}
