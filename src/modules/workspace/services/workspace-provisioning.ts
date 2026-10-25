import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '@/shared/logging/logger';
import {
  getAntigravityDbPaths,
  getAntigravityExtensionsDir,
  getAntigravityHostUserDir,
  getAppDataDir,
  type PathResolutionOptions,
} from '@/shared/platform/paths';

export interface HistorySeedingOptions {
  profileUserDataDir: string;
  hostDbPath?: string;
  timeoutMs?: number;
}

export interface WorkspaceProfileSharingOptions {
  profileUserDataDir: string;
  isolatedHome: string;
  hostUserDir?: string;
  hostGeminiDir?: string;
  hostExtensionsDir?: string;
  hostDbPath?: string;
}

/**
 * Inspects whether a destination path is absent, treating broken/dangling symlinks
 * as present so they can be cleaned up or avoided rather than throwing ENOENT unexpectedly.
 */
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

/**
 * Resolves the primary host state.vscdb candidate path that exists on disk.
 */
export function resolveHostStateDbPath(options?: PathResolutionOptions): string | null {
  const candidatePaths = [
    ...getAntigravityDbPaths('classic', options),
    ...getAntigravityDbPaths('ide', options),
  ];
  return (
    candidatePaths.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/**
 * Resolves the host Antigravity User directory if present on disk.
 */
export function resolveHostUserDir(options?: PathResolutionOptions): string | null {
  const hostUserDir = getAntigravityHostUserDir(options);
  try {
    return fs.existsSync(hostUserDir) ? hostUserDir : null;
  } catch {
    return null;
  }
}

/**
 * Seeds recent project history ('history.recentlyOpenedPathsList') from host state.vscdb
 * into the profile's state.vscdb ItemTable if absent.
 *
 * STRICT CREDENTIAL ISOLATION:
 * - Only 'history.recentlyOpenedPathsList' is queried from host.
 * - Under no condition are host auth tokens or identity keys copied into the profile.
 * - Existing profile history is never overwritten.
 * - Host database is opened in read-only mode with timeout to prevent blocking on locks.
 */
export function seedRecentProjectHistory(options: HistorySeedingOptions): void {
  try {
    const profileDbPath = path.join(
      options.profileUserDataDir,
      'User',
      'globalStorage',
      'state.vscdb',
    );
    if (!fs.existsSync(profileDbPath)) {
      return;
    }

    const hostDbPath = options.hostDbPath ?? resolveHostStateDbPath();
    if (!hostDbPath || !fs.existsSync(hostDbPath)) {
      return;
    }

    // Do not read from the same database
    if (path.resolve(hostDbPath) === path.resolve(profileDbPath)) {
      return;
    }

    // 1. Read host history in read-only mode with timeout
    let hostHistoryValue: string | null = null;
    let hostDb: Database.Database | null = null;
    try {
      hostDb = new Database(hostDbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: options.timeoutMs ?? 1500,
      });
      const tableCheck = hostDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'")
        .get();
      if (!tableCheck) {
        return;
      }
      const row = hostDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value?: string } | undefined;
      if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
        hostHistoryValue = row.value;
      }
    } catch (err) {
      logger.warn('Failed to read history from host state.vscdb', err);
      return;
    } finally {
      if (hostDb) {
        try {
          hostDb.close();
        } catch {
          // ignore close error
        }
      }
    }

    if (!hostHistoryValue) {
      return;
    }

    // Validate JSON structure before seeding
    try {
      JSON.parse(hostHistoryValue);
    } catch {
      logger.warn('Host history.recentlyOpenedPathsList is invalid JSON; skipping seeding');
      return;
    }

    // 2. Insert into profile database if absent (never overwrite existing)
    let profileDb: Database.Database | null = null;
    try {
      profileDb = new Database(profileDbPath, { fileMustExist: true, timeout: 3000 });
      profileDb.exec(`
        CREATE TABLE IF NOT EXISTS ItemTable (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      const existing = profileDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value?: string } | undefined;

      if (!existing || existing.value === null || existing.value === undefined) {
        profileDb
          .prepare(
            "INSERT OR IGNORE INTO ItemTable (key, value) VALUES ('history.recentlyOpenedPathsList', ?)",
          )
          .run(hostHistoryValue);
        logger.info(`Seeded recent project history into profile state.vscdb (${profileDbPath})`);
      }
    } catch (err) {
      logger.warn('Failed to seed history into profile state.vscdb', err);
    } finally {
      if (profileDb) {
        try {
          profileDb.close();
        } catch {
          // ignore close error
        }
      }
    }
  } catch (err) {
    logger.warn('Defensive error in seedRecentProjectHistory', err);
  }
}

/**
 * Idempotently symlinks host settings.json, keybindings.json, and snippets/
 * into the profile's User/ directory if present on host and absent in profile.
 */
export function provisionEditorSettings(profileUserDataDir: string, hostUserDir?: string): void {
  try {
    const effectiveHostUserDir = hostUserDir ?? getAntigravityHostUserDir();
    if (!fs.existsSync(effectiveHostUserDir)) {
      return;
    }

    const profileUserDir = path.join(profileUserDataDir, 'User');
    if (path.resolve(effectiveHostUserDir) === path.resolve(profileUserDir)) {
      return;
    }

    fs.mkdirSync(profileUserDir, { recursive: true });

    // File settings
    const filesToShare = ['settings.json', 'keybindings.json'];
    for (const file of filesToShare) {
      const src = path.join(effectiveHostUserDir, file);
      const dest = path.join(profileUserDir, file);
      if (fs.existsSync(src)) {
        safeSymlink(src, dest, 'file');
      }
    }

    // Directory settings (snippets)
    const dirsToShare = ['snippets'];
    for (const dir of dirsToShare) {
      const src = path.join(effectiveHostUserDir, dir);
      const dest = path.join(profileUserDir, dir);
      if (fs.existsSync(src)) {
        safeSymlink(src, dest, 'dir');
      }
    }
  } catch (err) {
    logger.warn('Defensive error in provisionEditorSettings', err);
  }
}

/**
 * Idempotently symlinks non-auth customization directories from host ~/.gemini/
 * (antigravity, config, and skills if present) into the profile's isolated home ~/.gemini/.
 *
 * STRICT CREDENTIAL ISOLATION INVARIANT:
 * - jetski-standalone-oauth-token, google_accounts.json, and oauth_creds.json are NEVER symlinked or copied.
 */
export function provisionGeminiCustomizations(isolatedHome: string, hostGeminiDir?: string): void {
  try {
    const effectiveHostGeminiDir = hostGeminiDir ?? path.join(os.homedir(), '.gemini');
    if (!fs.existsSync(effectiveHostGeminiDir)) {
      return;
    }

    const profileGeminiDir = path.join(isolatedHome, '.gemini');
    if (path.resolve(effectiveHostGeminiDir) === path.resolve(profileGeminiDir)) {
      return;
    }

    fs.mkdirSync(profileGeminiDir, { recursive: true });

    // Allowlisted customization subdirectories ONLY
    const customDirs = ['antigravity', 'config', 'skills'];
    for (const dir of customDirs) {
      const src = path.join(effectiveHostGeminiDir, dir);
      const dest = path.join(profileGeminiDir, dir);
      if (fs.existsSync(src)) {
        safeSymlink(src, dest, 'dir');
      }
    }
  } catch (err) {
    logger.warn('Defensive error in provisionGeminiCustomizations', err);
  }
}

/**
 * Idempotently links profile extensions directories to the host extensions directory.
 */
export function provisionExtensionsSharing(
  profileUserDataDir: string,
  isolatedHome: string,
  hostExtensionsDir?: string,
): void {
  try {
    const effectiveHostExtensionsDir = hostExtensionsDir ?? getAntigravityExtensionsDir();
    if (!fs.existsSync(effectiveHostExtensionsDir)) {
      return;
    }

    const destProfileExtensions = path.join(profileUserDataDir, 'extensions');
    if (path.resolve(effectiveHostExtensionsDir) !== path.resolve(destProfileExtensions)) {
      safeSymlink(effectiveHostExtensionsDir, destProfileExtensions, 'dir');
    }

    const destIsolatedHomeExtensions = path.join(isolatedHome, '.antigravity', 'extensions');
    if (path.resolve(effectiveHostExtensionsDir) !== path.resolve(destIsolatedHomeExtensions)) {
      safeSymlink(effectiveHostExtensionsDir, destIsolatedHomeExtensions, 'dir');
    }
  } catch (err) {
    logger.warn('Defensive error in provisionExtensionsSharing', err);
  }
}

/**
 * Orchestrates all profile sharing provisions:
 * 1. Extensions sharing
 * 2. Editor configuration inheritance
 * 3. Gemini agent skills inheritance
 * 4. Recent project history seeding
 */
export function provisionWorkspaceProfileSharing(options: WorkspaceProfileSharingOptions): void {
  try {
    const defaultClassicDir = getAppDataDir('classic');
    const defaultIdeDir = getAppDataDir('ide');
    const resolvedProfileDir = path.resolve(options.profileUserDataDir);
    if (
      resolvedProfileDir === path.resolve(defaultClassicDir) ||
      resolvedProfileDir === path.resolve(defaultIdeDir)
    ) {
      logger.info(
        `Skipping workspace profile sharing for default directory: ${options.profileUserDataDir}`,
      );
      return;
    }

    provisionExtensionsSharing(
      options.profileUserDataDir,
      options.isolatedHome,
      options.hostExtensionsDir,
    );
    provisionEditorSettings(options.profileUserDataDir, options.hostUserDir);
    provisionGeminiCustomizations(options.isolatedHome, options.hostGeminiDir);
    seedRecentProjectHistory({
      profileUserDataDir: options.profileUserDataDir,
      hostDbPath: options.hostDbPath,
    });
  } catch (err) {
    logger.warn('Defensive error in provisionWorkspaceProfileSharing', err);
  }
}
