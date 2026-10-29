import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/shared/logging/logger';
import Database from 'better-sqlite3';
import {
  getAntigravityDbPaths,
  getAntigravityHostUserDir,
  type PathResolutionOptions,
} from '@/shared/platform/paths';
export interface HistorySeedingOptions {
  profileUserDataDir: string;
  hostDbPath?: string;
  timeoutMs?: number;
  pathOptions?: PathResolutionOptions;
}
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
export function seedRecentProjectHistory(options: HistorySeedingOptions): boolean {
  try {
    const profileDbPath = path.join(
      options.profileUserDataDir,
      'User',
      'globalStorage',
      'state.vscdb',
    );
    if (!fs.existsSync(profileDbPath)) {
      return true;
    }

    const hostDbPath = options.hostDbPath ?? resolveHostStateDbPath(options.pathOptions);
    if (!hostDbPath || !fs.existsSync(hostDbPath)) {
      return true;
    }

    // Do not read from the same database
    if (path.resolve(hostDbPath) === path.resolve(profileDbPath)) {
      return true;
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
        return true;
      }
      const row = hostDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value?: string } | undefined;
      if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
        hostHistoryValue = row.value;
      }
    } catch (err) {
      logger.warn('Failed to read history from host state.vscdb', err);
      return false;
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
      return true;
    }

    // Validate JSON structure before seeding
    try {
      JSON.parse(hostHistoryValue);
    } catch {
      logger.warn('Host history.recentlyOpenedPathsList is invalid JSON; skipping seeding');
      return false;
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
      return false;
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
    return false;
  }
  return true;
}
