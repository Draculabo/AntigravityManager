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
import { WorkspaceProfileRepo } from '../persistence/workspace-profile-repo';
import type { WorkspaceProfile } from '../types';

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
 * Determines whether a pre-existing physical directory inside ~/.gemini/
 * is merely empty boilerplate / scaffolding created during an initial launch
 * before profile sharing symlinks were in place.
 */
export function isStaleOrScaffoldGeminiDir(targetDir: string, dirName: string): boolean {
  try {
    if (!fs.existsSync(targetDir)) {
      return true;
    }

    if (dirName === 'antigravity') {
      const knownAntigravityScaffoldItems = new Set([
        'bin',
        'brain',
        'builtin',
        'conversations',
        'conversation_summaries.db',
        'conversation_summaries.db-journal',
        'conversation_summaries.db-wal',
        'conversation_summaries.db-shm',
        'crashes',
        'installation_id',
        'antigravity_state.pbtxt',
      ]);
      const entries = fs.readdirSync(targetDir);
      for (const entry of entries) {
        if (!knownAntigravityScaffoldItems.has(entry)) {
          return false; // Contains custom user file/directory -> NOT stale!
        }
      }

      // 1. Check brain/ directory: does it have non-empty conversation directories?
      const brainDir = path.join(targetDir, 'brain');
      if (fs.existsSync(brainDir)) {
        try {
          const brainEntries = fs.readdirSync(brainDir);
          for (const entry of brainEntries) {
            const entryPath = path.join(brainDir, entry);
            const stat = fs.statSync(entryPath);
            if (stat.isDirectory()) {
              const files = fs.readdirSync(entryPath);
              if (files.length > 0) {
                return false; // Contains conversation transcripts/data
              }
            } else {
              return false;
            }
          }
        } catch {
          // If unreadable, treat conservatively as non-stale
          return false;
        }
      }

      // 2. Check conversations/ directory: does it have any conversation state files?
      const convDir = path.join(targetDir, 'conversations');
      if (fs.existsSync(convDir)) {
        try {
          const convEntries = fs.readdirSync(convDir);
          if (convEntries.length > 0) {
            return false;
          }
        } catch {
          return false;
        }
      }

      // 3. Check conversation_summaries.db: does it contain any conversation rows?
      const dbPath = path.join(targetDir, 'conversation_summaries.db');
      if (fs.existsSync(dbPath)) {
        let db: Database.Database | null = null;
        try {
          db = new Database(dbPath, { readonly: true, timeout: 1000 });
          const tableCheck = db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
            )
            .get();
          if (tableCheck) {
            const rowCount = db
              .prepare('SELECT count(*) as count FROM conversation_summaries')
              .get() as { count?: number } | undefined;
            if (rowCount && typeof rowCount.count === 'number' && rowCount.count > 0) {
              return false; // Non-zero conversations recorded
            }
          }
        } catch {
          // Fallback check on db file size: fresh empty db initialized by binary is <= 20480 bytes
          try {
            const stat = fs.statSync(dbPath);
            if (stat.size > 65536) {
              return false;
            }
          } catch {
            return false;
          }
        } finally {
          if (db) {
            try {
              db.close();
            } catch {
              // ignore
            }
          }
        }
      }

      // If brain, conversations, and conversation_summaries have no user conversations,
      // the remaining files (installation_id, antigravity_state.pbtxt, crashes, empty bin)
      // are standard scaffolding.
      return true;
    }

    if (dirName === 'config') {
      const knownConfigScaffoldItems = new Set([
        'plugins',
        'projects',
        'sidecars',
        'config.json',
        'mcp_config.json',
        '.migrated',
      ]);
      const entries = fs.readdirSync(targetDir);
      for (const entry of entries) {
        if (!knownConfigScaffoldItems.has(entry)) {
          return false; // Contains custom user file (e.g. profile.json, profile.txt, skills/) -> NOT stale!
        }
      }

      // 1. Check plugins, projects, sidecars
      for (const sub of ['plugins', 'projects', 'sidecars']) {
        const subPath = path.join(targetDir, sub);
        if (fs.existsSync(subPath)) {
          try {
            if (fs.readdirSync(subPath).length > 0) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }

      // 2. Check mcp_config.json: does it define custom MCP servers?
      const mcpConfigPath = path.join(targetDir, 'mcp_config.json');
      if (fs.existsSync(mcpConfigPath)) {
        try {
          const content = fs.readFileSync(mcpConfigPath, 'utf8').trim();
          if (content.length > 0) {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object') {
              const keys = Object.keys(parsed);
              if (
                keys.length > 0 &&
                !(
                  keys.length === 1 &&
                  parsed.mcpServers &&
                  Object.keys(parsed.mcpServers).length === 0
                )
              ) {
                return false; // Has custom MCP configuration
              }
            }
          }
        } catch {
          return false;
        }
      }

      return true;
    }

    if (dirName === 'skills') {
      try {
        const entries = fs.readdirSync(targetDir);
        return entries.length === 0;
      } catch {
        return false;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Safely copies any unique conversation folders from a profile's physical brain directory
 * to the host brain directory if absent on host, preserving user conversation history.
 */
export function mergeUniqueConversationsToHost(dest: string, src: string): void {
  try {
    const destBrain = path.join(dest, 'brain');
    const srcBrain = path.join(src, 'brain');
    if (fs.existsSync(destBrain) && fs.existsSync(srcBrain)) {
      const convEntries = fs.readdirSync(destBrain);
      for (const convId of convEntries) {
        const srcConvPath = path.join(srcBrain, convId);
        const destConvPath = path.join(destBrain, convId);
        try {
          const stat = fs.statSync(destConvPath);
          if (stat.isDirectory() && !fs.existsSync(srcConvPath)) {
            fs.cpSync(destConvPath, srcConvPath, { recursive: true });
            logger.info(`Merged profile conversation "${convId}" into host brain directory`);
          }
        } catch (copyErr) {
          logger.warn(`Failed to merge conversation "${convId}" to host:`, copyErr);
        }
      }
    }

    // Merge summaries db rows if both exist
    const destDbPath = path.join(dest, 'conversation_summaries.db');
    const srcDbPath = path.join(src, 'conversation_summaries.db');
    if (fs.existsSync(destDbPath) && fs.existsSync(srcDbPath)) {
      let destDb: Database.Database | null = null;
      let srcDb: Database.Database | null = null;
      try {
        destDb = new Database(destDbPath, { readonly: true, timeout: 1000 });
        const destHasTable = destDb
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
          )
          .get();
        if (destHasTable) {
          const rows = destDb.prepare('SELECT * FROM conversation_summaries').all() as Array<
            Record<string, unknown>
          >;
          if (rows.length > 0 && rows[0]) {
            srcDb = new Database(srcDbPath, { timeout: 3000 });
            const srcHasTable = srcDb
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
              )
              .get();
            if (srcHasTable) {
              const columns = Object.keys(rows[0]);
              const placeholders = columns.map((col) => `@${col}`).join(', ');
              const insert = srcDb.prepare(
                `INSERT OR IGNORE INTO conversation_summaries (${columns.join(', ')}) VALUES (${placeholders})`,
              );
              const insertMany = srcDb.transaction((records: Array<Record<string, unknown>>) => {
                for (const record of records) {
                  try {
                    insert.run(record);
                  } catch {
                    // ignore individual row failure if schema differs slightly
                  }
                }
              });
              insertMany(rows);
              logger.info(`Merged ${rows.length} conversation summary rows into host database`);
            }
          }
        }
      } catch (dbErr) {
        logger.warn('Failed to merge conversation summaries db to host:', dbErr);
      } finally {
        if (destDb) {
          try {
            destDb.close();
          } catch {
            // ignore
          }
        }
        if (srcDb) {
          try {
            srcDb.close();
          } catch {
            // ignore
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to merge unique conversations to host:', err);
  }
}

/**
 * Idempotently symlinks non-auth customization directories from host ~/.gemini/
 * (antigravity, config, and skills if present) into the profile's isolated home ~/.gemini/.
 *
 * SELF-HEALING RECONCILIATION:
 * - Detects pre-existing stale/empty scaffolding physical directories in profile ~/.gemini/
 *   (e.g., created by IDE before symlinks were wired up) and replaces them with live symlinks to host.
 * - If a physical directory contains unique user conversations, merges transcripts to host
 *   and preserves a timestamped .user-backup before establishing the symlink.
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
      if (!fs.existsSync(src)) {
        continue;
      }

      try {
        let isSymlink = false;
        try {
          const stat = fs.lstatSync(dest);
          isSymlink = stat.isSymbolicLink();
        } catch {
          isSymlink = false;
        }

        if (fs.existsSync(dest) && !isSymlink) {
          if (isStaleOrScaffoldGeminiDir(dest, dir)) {
            fs.rmSync(dest, { recursive: true, force: true });
            logger.info(
              `Reconciled stale Gemini scaffold directory "${dest}" with symlink to "${src}"`,
            );
          } else {
            logger.info(
              `Preserved pre-existing customized Gemini directory "${dest}" without overwriting`,
            );
            continue;
          }
        }
      } catch (reconcileErr) {
        logger.warn(`Failed to reconcile pre-existing directory "${dest}":`, reconcileErr);
      }

      safeSymlink(src, dest, 'dir');
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

export interface ReconcileProfilesResult {
  reconciledCount: number;
  profiles: Array<{ id: string; name: string; reconciled: boolean }>;
}

export interface ReconcileAllProfilesOptions {
  profileRepo?: {
    listProfiles(options?: { dbPath?: string }): Promise<WorkspaceProfile[]>;
  };
  dbPath?: string;
  hostUserDir?: string;
  hostGeminiDir?: string;
  hostExtensionsDir?: string;
  hostDbPath?: string;
}

/**
 * Iterates through all registered workspace profiles and reconciles their shared environment:
 * - Replaces any stale scaffolding with symlinks to host conversations, skills, and extensions.
 * - Seeds recent project history into profile state.vscdb.
 * - Guarantees strict credential isolation across all profiles.
 */
export async function reconcileAllWorkspaceProfiles(
  options?: ReconcileAllProfilesOptions,
): Promise<ReconcileProfilesResult> {
  const repo = options?.profileRepo ?? WorkspaceProfileRepo;
  const profiles = await repo.listProfiles({ dbPath: options?.dbPath });
  let reconciledCount = 0;
  const results: Array<{ id: string; name: string; reconciled: boolean }> = [];

  for (const profile of profiles) {
    try {
      const isolatedHome = path.join(profile.userDataDir, 'home');
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profile.userDataDir,
        isolatedHome,
        hostUserDir: options?.hostUserDir,
        hostGeminiDir: options?.hostGeminiDir,
        hostExtensionsDir: options?.hostExtensionsDir,
        hostDbPath: options?.hostDbPath,
      });
      reconciledCount++;
      results.push({ id: profile.id, name: profile.name, reconciled: true });
    } catch (err) {
      logger.warn(`Failed to reconcile workspace profile ${profile.id} (${profile.name}):`, err);
      results.push({ id: profile.id, name: profile.name, reconciled: false });
    }
  }

  return { reconciledCount, profiles: results };
}
