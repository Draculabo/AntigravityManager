import Database from "better-sqlite3";
import fs from "fs";
import { getAntigravityDbPaths } from "../../utils/paths";
import { logger } from "../../utils/logger";
import { AccountBackupData, AccountInfo } from "../../types/account";

import path from "path";

// Keys to backup (matching Python implementation)
const KEYS_TO_BACKUP = [
  "antigravityAuthStatus",
  "jetskiStateSync.agentManagerInitState",
];

function ensureDatabaseExists(dbPath: string): void {
  if (fs.existsSync(dbPath)) {
    return;
  }

  logger.info(`Database file not found at ${dbPath}. Creating new database...`);

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    // Initialize schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    logger.info("Created new database with ItemTable schema.");
  } catch (error) {
    logger.error("Failed to create new database", error);
    throw error;
  } finally {
    if (db) db.close();
  }
}

export function getDatabaseConnection(dbPath?: string): Database.Database {
  const targetPath = dbPath || getAntigravityDbPaths()[0];

  if (!targetPath) {
    throw new Error("No Antigravity database path found");
  }

  ensureDatabaseExists(targetPath);

  try {
    return new Database(targetPath, { readonly: false, fileMustExist: false });
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED") {
      throw new Error(
        "Database is locked. Please close Antigravity before proceeding.",
      );
    }
    throw error;
  }
}

export function getCurrentAccountInfo(): AccountInfo {
  // Database existence is now handled by getDatabaseConnection
  let db: Database.Database | null = null;
  try {
    db = getDatabaseConnection();

    // Query for auth status
    const authRow = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
      )
      .get() as { value: string } | undefined;

    let authStatus = null;
    if (authRow) {
      try {
        authStatus = JSON.parse(authRow.value);
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Query for user info (usually in jetskiStateSync.agentManagerInitState or similar)
    // Based on Python implementation, we look for email in auth status or init state
    const initRow = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'",
      )
      .get() as { value: string } | undefined;

    let initState = null;
    if (initRow) {
      try {
        initState = JSON.parse(initRow.value);
      } catch {
        // Ignore JSON parse errors (this key often contains non-JSON data)
      }
    }

    // Query for google.antigravity (Python logic)
    const googleRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'google.antigravity'")
      .get() as { value: string } | undefined;

    let googleState = null;
    if (googleRow) {
      try {
        googleState = JSON.parse(googleRow.value);
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Query for antigravityUserSettings.allUserSettings (Python logic)
    const settingsRow = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'antigravityUserSettings.allUserSettings'",
      )
      .get() as { value: string } | undefined;

    let settingsState = null;
    if (settingsRow) {
      try {
        settingsState = JSON.parse(settingsRow.value);
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Helper to find email in object
    const findEmail = (obj: any): string => {
      if (!obj) return "";
      if (typeof obj.email === "string") return obj.email;
      if (obj.user && typeof obj.user.email === "string") return obj.user.email;
      return "";
    };

    const email =
      findEmail(authStatus) ||
      findEmail(initState) ||
      findEmail(googleState) ||
      findEmail(settingsState) ||
      "";

    const name =
      authStatus?.user?.name ||
      initState?.user?.name ||
      authStatus?.name ||
      "";
    const isAuthenticated = !!email;

    logger.info(
      `Account info: authenticated=${isAuthenticated}, email=${email || "none"}`,
    );

    return {
      email,
      name,
      isAuthenticated,
    };
  } catch (error) {
    logger.error("Failed to get current account info", error);
    throw error;
  } finally {
    if (db) db.close();
  }
}

export function backupAccount(
  account: AccountBackupData["account"],
): AccountBackupData {
  let db: Database.Database | null = null;
  try {
    db = getDatabaseConnection();

    // Backup only specific keys (matching Python implementation)
    const data: Record<string, unknown> = {};

    for (const key of KEYS_TO_BACKUP) {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(key) as { value: string } | undefined;

      if (row) {
        try {
          data[key] = JSON.parse(row.value);
        } catch {
          data[key] = row.value;
        }
        logger.debug(`Backed up key: ${key}`);
      } else {
        logger.debug(`Key not found: ${key}`);
      }
    }

    // Add metadata
    data["account_email"] = account.email;
    data["backup_time"] = new Date().toISOString();

    return {
      version: "1.0",
      account,
      data,
    };
  } catch (error) {
    logger.error("Failed to backup account", error);
    throw error;
  } finally {
    if (db) db.close();
  }
}

export function restoreAccount(backup: AccountBackupData): void {
  const dbPaths = getAntigravityDbPaths();
  if (dbPaths.length === 0) {
    throw new Error("No Antigravity database paths found");
  }

  let successCount = 0;

  for (const dbPath of dbPaths) {
    // Restore main DB
    if (_restoreSingleDb(dbPath, backup)) {
      successCount++;
    }

    // Restore backup DB (if exists)
    const backupDbPath = dbPath.replace(/\.vscdb$/, ".vscdb.backup");
    if (fs.existsSync(backupDbPath)) {
      if (_restoreSingleDb(backupDbPath, backup)) {
        successCount++;
      }
    }
  }

  if (successCount > 0) {
    logger.info(`Account data restored successfully to ${successCount} files`);
  } else {
    throw new Error("Failed to restore account data to any database file");
  }
}

function _restoreSingleDb(
  dbPath: string,
  backup: AccountBackupData,
): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  logger.info(`Restoring database: ${dbPath}`);
  let db: Database.Database | null = null;

  try {
    db = getDatabaseConnection(dbPath);

    const insert = db.prepare(
      "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
    );

    const transaction = db.transaction(() => {
      // Only restore the keys that were backed up (matching Python)
      for (const key of KEYS_TO_BACKUP) {
        if (key in backup.data) {
          const value = backup.data[key];
          const stringValue =
            typeof value === "string" ? value : JSON.stringify(value);
          insert.run(key, stringValue);
          logger.debug(`Restored key: ${key}`);
        }
      }
    });

    transaction();
    logger.info(`Database restoration complete: ${dbPath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to restore database: ${dbPath}`, error);
    return false;
  } finally {
    if (db) db.close();
  }
}
