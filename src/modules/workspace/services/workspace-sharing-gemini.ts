import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/shared/logging/logger';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { safeSymlink } from './workspace-sharing-files';
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
      const configFile = path.join(targetDir, 'config.json');
      if (fs.existsSync(configFile)) {
        if (fs.statSync(configFile).size > 65536) {
          return false;
        }
        const value = fs.readFileSync(configFile, 'utf8').trim();
        if (value && value !== '{}') {
          return false;
        }
      }
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

export function provisionGeminiCustomizations(
  isolatedHome: string,
  hostGeminiDir?: string,
): boolean {
  let complete = true;
  try {
    const effectiveHostGeminiDir = hostGeminiDir ?? path.join(os.homedir(), '.gemini');
    if (!fs.existsSync(effectiveHostGeminiDir)) {
      return true;
    }

    const profileGeminiDir = path.join(isolatedHome, '.gemini');
    if (path.resolve(effectiveHostGeminiDir) === path.resolve(profileGeminiDir)) {
      return true;
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
            // Rename before replacement: even recognized scaffolding can contain future client data.
            const backup = `${dest}.sharing-backup-${randomUUID()}`;
            fs.renameSync(dest, backup);
            if (!safeSymlink(src, dest, 'dir')) {
              complete = false;
              if (!fs.lstatSync(dest, { throwIfNoEntry: false })) {
                fs.renameSync(backup, dest);
              }
            }
            continue;
          } else {
            logger.info(
              `Preserved pre-existing customized Gemini directory "${dest}" without overwriting`,
            );
            continue;
          }
        }
      } catch (reconcileErr) {
        logger.warn(`Failed to reconcile pre-existing directory "${dest}":`, reconcileErr);
        complete = false;
        continue;
      }

      complete = safeSymlink(src, dest, 'dir') && complete;
    }
  } catch (err) {
    logger.warn('Defensive error in provisionGeminiCustomizations', err);
    return false;
  }
  return complete;
}
