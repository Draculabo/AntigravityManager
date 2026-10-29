import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { logger } from '@/shared/logging/logger';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import { workspaceProfiles } from '@/shared/persistence/database/schema';
import { getProfilesBaseDir, getProfileUserDataDir } from '@/shared/platform/paths';
import {
  WorkspaceProfileSchema,
  WorkspaceProfileNotFoundError,
  WorkspaceValidationError,
  type CreateWorkspaceProfileInput,
  type UpdateWorkspaceProfileInput,
  type WorkspaceProfile,
} from '../types';

type ProfileRow = typeof workspaceProfiles.$inferSelect;

function mapRowToProfile(row: ProfileRow): WorkspaceProfile {
  return WorkspaceProfileSchema.parse({
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    projectPath: row.projectPath,
    userDataDir: row.userDataDir,
    createdAt: row.createdAt,
    lastLaunchedAt: row.lastLaunchedAt ?? null,
  });
}

export interface CreateProfileOptions {
  id?: string;
  userDataDir?: string;
  dbPath?: string;
}

export class WorkspaceProfileRepo {
  private static customDbPath: string | null = null;

  /**
   * Configures an isolated database path for testing without touching user production data.
   */
  static setDatabasePath(dbPath: string | null): void {
    this.customDbPath = dbPath;
  }

  static getDatabasePath(): string | null {
    return this.customDbPath;
  }

  private static getDb(explicitDbPath?: string) {
    return getCloudDb(explicitDbPath ?? this.customDbPath ?? undefined);
  }

  /**
   * Retrieves all workspace profiles ordered by creation time descending (newest first).
   * Fault-tolerant: Corrupted or malformed rows are quarantined and logged rather than crashing the list.
   */
  static async listProfiles(options?: { dbPath?: string }): Promise<WorkspaceProfile[]> {
    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const rows = orm
        .select()
        .from(workspaceProfiles)
        .orderBy(desc(workspaceProfiles.createdAt))
        .all();
      const validProfiles: WorkspaceProfile[] = [];
      for (const row of rows) {
        try {
          validProfiles.push(mapRowToProfile(row));
        } catch (error) {
          logger.warn(`Skipping corrupted workspace profile row (id: ${row.id})`, error);
        }
      }
      return validProfiles;
    } finally {
      raw.close();
    }
  }

  /**
   * Retrieves a single workspace profile by its unique ID.
   */
  static async getProfile(
    id: string,
    options?: { dbPath?: string },
  ): Promise<WorkspaceProfile | null> {
    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const row = orm.select().from(workspaceProfiles).where(eq(workspaceProfiles.id, id)).get();
      return row ? mapRowToProfile(row) : null;
    } finally {
      raw.close();
    }
  }

  /**
   * Creates a new workspace profile, generates a UUID (if not provided), bootstraps
   * the profile directory structure on disk, and persists the record.
   * Atomicity: cleans up bootstrapped directories if SQLite insertion fails.
   */
  static async createProfile(
    input: CreateWorkspaceProfileInput,
    options?: CreateProfileOptions,
  ): Promise<WorkspaceProfile> {
    const rawProjectPath = (input.projectPath ?? '').trim();
    if (!path.isAbsolute(rawProjectPath)) {
      throw new WorkspaceValidationError(
        `Project path must be an absolute path: "${input.projectPath}"`,
      );
    }

    const id = options?.id ?? randomUUID();
    // Validate UUID format for options.id
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new WorkspaceValidationError(`Invalid workspace ID format: "${id}"`);
    }

    let userDataDir: string;
    if (options?.userDataDir) {
      const baseProfilesDir = path.resolve(getProfilesBaseDir());
      const targetDir = path.resolve(options.userDataDir);
      const relative = path.relative(baseProfilesDir, targetDir);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new WorkspaceValidationError(
          `Custom userDataDir must be contained inside profiles base directory: "${options.userDataDir}"`,
        );
      }
      userDataDir = targetDir;
    } else {
      userDataDir = getProfileUserDataDir(id);
    }

    const newProfile: WorkspaceProfile = {
      id,
      name: input.name.trim(),
      accountId: input.accountId.trim(),
      projectPath: rawProjectPath,
      userDataDir,
      createdAt: Date.now(),
      lastLaunchedAt: null,
    };

    // Validate entity structure before touching disk or database
    WorkspaceProfileSchema.parse(newProfile);

    // Bootstrap directory structure: <userDataDir>/User/globalStorage/
    const globalStorageDir = path.join(userDataDir, 'User', 'globalStorage');
    let bootstrappedDir = false;
    if (!fs.existsSync(globalStorageDir)) {
      fs.mkdirSync(globalStorageDir, { recursive: true });
      bootstrappedDir = true;
      logger.debug(`Bootstrapped profile storage directory: ${globalStorageDir}`);
    }

    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      try {
        orm
          .insert(workspaceProfiles)
          .values({
            id: newProfile.id,
            name: newProfile.name,
            accountId: newProfile.accountId,
            projectPath: newProfile.projectPath,
            userDataDir: newProfile.userDataDir,
            createdAt: newProfile.createdAt,
            lastLaunchedAt: null,
          })
          .run();
      } catch (insertError) {
        if (bootstrappedDir && fs.existsSync(userDataDir)) {
          try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            logger.debug(`Cleaned up bootstrapped directory after failed insert: ${userDataDir}`);
          } catch (cleanupError) {
            logger.warn(
              `Failed to clean up directory after insert error: ${userDataDir}`,
              cleanupError,
            );
          }
        }
        throw insertError;
      }

      logger.info(`Created workspace profile: ${newProfile.name} (${newProfile.id})`);
      return newProfile;
    } finally {
      raw.close();
    }
  }

  /**
   * Updates an existing workspace profile's mutable fields (name, accountId, projectPath).
   * Atomicity: Validates candidate changes before mutating SQLite to prevent corrupt rows.
   */
  static async updateProfile(
    input: UpdateWorkspaceProfileInput,
    options?: { dbPath?: string },
  ): Promise<WorkspaceProfile> {
    if (input.projectPath !== undefined && !path.isAbsolute(input.projectPath.trim())) {
      throw new WorkspaceValidationError(
        `Project path must be an absolute path: "${input.projectPath}"`,
      );
    }

    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const existing = orm
        .select()
        .from(workspaceProfiles)
        .where(eq(workspaceProfiles.id, input.id))
        .get();

      if (!existing) {
        throw new WorkspaceProfileNotFoundError(input.id);
      }

      const existingProfile = mapRowToProfile(existing);
      const updatedCandidate: WorkspaceProfile = {
        ...existingProfile,
        name: input.name !== undefined ? input.name.trim() : existingProfile.name,
        accountId:
          input.accountId !== undefined ? input.accountId.trim() : existingProfile.accountId,
        projectPath:
          input.projectPath !== undefined ? input.projectPath.trim() : existingProfile.projectPath,
      };

      // Validate candidate row BEFORE modifying SQLite
      WorkspaceProfileSchema.parse(updatedCandidate);

      const updates: Partial<typeof workspaceProfiles.$inferInsert> = {};
      if (input.name !== undefined) updates.name = input.name.trim();
      if (input.accountId !== undefined) updates.accountId = input.accountId.trim();
      if (input.projectPath !== undefined) updates.projectPath = input.projectPath.trim();

      if (Object.keys(updates).length > 0) {
        orm.update(workspaceProfiles).set(updates).where(eq(workspaceProfiles.id, input.id)).run();
        logger.info(`Updated workspace profile ${input.id}`);
      }

      return updatedCandidate;
    } finally {
      raw.close();
    }
  }

  /**
   * Deletes a workspace profile row from the database.
   */
  static async deleteProfile(id: string, options?: { dbPath?: string }): Promise<boolean> {
    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const result = orm.delete(workspaceProfiles).where(eq(workspaceProfiles.id, id)).run();
      const deleted = result.changes > 0;
      if (deleted) {
        logger.info(`Deleted workspace profile record: ${id}`);
      } else {
        logger.warn(`deleteProfile: No profile found with ID ${id}`);
      }
      return deleted;
    } finally {
      raw.close();
    }
  }

  /**
   * Updates the lastLaunchedAt timestamp for a profile.
   */
  static async updateLastLaunched(
    id: string,
    timestamp?: number,
    options?: { dbPath?: string },
  ): Promise<WorkspaceProfile> {
    const lastLaunchedAt = timestamp ?? Date.now();
    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const result = orm
        .update(workspaceProfiles)
        .set({ lastLaunchedAt })
        .where(eq(workspaceProfiles.id, id))
        .run();

      if (result.changes === 0) {
        throw new WorkspaceProfileNotFoundError(id);
      }

      const updated = orm
        .select()
        .from(workspaceProfiles)
        .where(eq(workspaceProfiles.id, id))
        .get();

      return mapRowToProfile(updated!);
    } finally {
      raw.close();
    }
  }

  /**
   * Finds all profiles bound to a given Google account ID.
   */
  static async getProfilesByAccountId(
    accountId: string,
    options?: { dbPath?: string },
  ): Promise<WorkspaceProfile[]> {
    const { raw, orm } = this.getDb(options?.dbPath);
    try {
      const rows = orm
        .select()
        .from(workspaceProfiles)
        .where(eq(workspaceProfiles.accountId, accountId))
        .all();
      const validProfiles: WorkspaceProfile[] = [];
      for (const row of rows) {
        try {
          validProfiles.push(mapRowToProfile(row));
        } catch (error) {
          logger.warn(`Skipping corrupted workspace profile row (id: ${row.id})`, error);
        }
      }
      return validProfiles;
    } finally {
      raw.close();
    }
  }
}
