import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '@/shared/logging/logger';
import { projectCloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { getProfilesBaseDir } from '@/shared/platform/paths';
import { WorkspaceProfileRepo } from '../persistence/workspace-profile-repo';
import {
  CreateWorkspaceProfileInputSchema,
  UpdateWorkspaceProfileInputSchema,
  type CreateWorkspaceProfileInput,
  type UpdateWorkspaceProfileInput,
  type WorkspaceProfile,
  type WorkspaceProfileStatus,
  type WorkspaceProfileView,
  WorkspaceNotFoundError,
  AccountNotFoundError,
  WorkspaceValidationError,
  WorkspaceDirectoryError,
  type WorkspaceLifecycleDelegate,
  type SyncWorkspaceProfilesResult,
} from '../types';
import { reconcileAllWorkspaceProfiles } from './workspace-provisioning';

export type { WorkspaceLifecycleDelegate };

export interface CloudAccountRepoLike {
  getAccounts(): Promise<CloudAccount[]>;
  getAccount(id: string): Promise<CloudAccount | null>;
}

export const defaultCloudAccountRepo: CloudAccountRepoLike = {
  async getAccounts(): Promise<CloudAccount[]> {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    return CloudAccountRepo.getAccounts();
  },
  async getAccount(id: string): Promise<CloudAccount | null> {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    return (await CloudAccountRepo.getAccount(id)) ?? null;
  },
};

export interface WorkspaceProfileServiceDependencies {
  profileRepo: typeof WorkspaceProfileRepo;
  cloudAccountRepo: CloudAccountRepoLike;
  lifecycleDelegate?: WorkspaceLifecycleDelegate;
}

export function createWorkspaceProfileService(deps: WorkspaceProfileServiceDependencies) {
  const launchProfile = async (id: string): Promise<{ pid: number }> => {
    const profile = await deps.profileRepo.getProfile(id);
    if (!profile) {
      throw new WorkspaceNotFoundError(id);
    }

    let pid = 0;
    if (deps.lifecycleDelegate) {
      const result = await deps.lifecycleDelegate.launch(id);
      pid = result.pid;
    }

    await deps.profileRepo.updateLastLaunched(id);
    return { pid };
  };

  const inFlightLaunchesByAccount = new Map<string, Promise<{ pid: number }>>();

  return {
    /**
     * Lists all workspace profiles enriched with bound Google account views and running status.
     */
    async listViews(): Promise<WorkspaceProfileView[]> {
      const [profiles, accounts] = await Promise.all([
        deps.profileRepo.listProfiles(),
        deps.cloudAccountRepo.getAccounts(),
      ]);

      const accountMap = new Map<string, CloudAccount>();
      for (const account of accounts) {
        accountMap.set(account.id, account);
      }

      const views: WorkspaceProfileView[] = [];
      for (const profile of profiles) {
        const boundAccount = accountMap.get(profile.accountId);
        const accountView = boundAccount ? projectCloudAccountView(boundAccount) : undefined;

        let status: WorkspaceProfileStatus = { running: false };
        if (deps.lifecycleDelegate) {
          try {
            status = await deps.lifecycleDelegate.getStatus(profile);
          } catch (error) {
            logger.warn(`Failed to read process status for profile ${profile.id}`, error);
          }
        }

        views.push({
          ...profile,
          status,
          account: accountView,
        });
      }

      return views;
    },

    /**
     * Retrieves a single workspace profile view by ID.
     */
    async getView(id: string): Promise<WorkspaceProfileView | null> {
      const profile = await deps.profileRepo.getProfile(id);
      if (!profile) {
        return null;
      }

      const boundAccount = await deps.cloudAccountRepo.getAccount(profile.accountId);
      const accountView = boundAccount ? projectCloudAccountView(boundAccount) : undefined;

      let status: WorkspaceProfileStatus = { running: false };
      if (deps.lifecycleDelegate) {
        try {
          status = await deps.lifecycleDelegate.getStatus(profile);
        } catch (error) {
          logger.warn(`Failed to read process status for profile ${profile.id}`, error);
        }
      }

      return {
        ...profile,
        status,
        account: accountView,
      };
    },

    /**
     * Creates a new workspace profile after validating that the bound account exists
     * and that the project path is valid.
     */
    async create(input: CreateWorkspaceProfileInput): Promise<WorkspaceProfile> {
      const validatedInput = CreateWorkspaceProfileInputSchema.parse(input);

      // Verify bound Google account exists in the pool
      const account = await deps.cloudAccountRepo.getAccount(validatedInput.accountId);
      if (!account) {
        throw new WorkspaceValidationError(
          `Bound Google Account "${validatedInput.accountId}" does not exist in the account pool`,
        );
      }

      // Verify project path is an absolute path
      if (!path.isAbsolute(validatedInput.projectPath)) {
        throw new WorkspaceValidationError(
          `Project path must be an absolute path: "${validatedInput.projectPath}"`,
        );
      }

      return deps.profileRepo.createProfile(validatedInput);
    },

    /**
     * Updates profile fields after validating existence and account validity.
     */
    async update(input: UpdateWorkspaceProfileInput): Promise<WorkspaceProfile> {
      const validatedInput = UpdateWorkspaceProfileInputSchema.parse(input);

      // If updating account, verify target account exists
      if (validatedInput.accountId !== undefined) {
        const account = await deps.cloudAccountRepo.getAccount(validatedInput.accountId);
        if (!account) {
          throw new WorkspaceValidationError(
            `Target Google Account "${validatedInput.accountId}" does not exist`,
          );
        }
      }

      // If updating project path, verify it is absolute
      if (
        validatedInput.projectPath !== undefined &&
        !path.isAbsolute(validatedInput.projectPath)
      ) {
        throw new WorkspaceValidationError(
          `Project path must be an absolute path: "${validatedInput.projectPath}"`,
        );
      }

      return deps.profileRepo.updateProfile(validatedInput);
    },

    /**
     * Deletes a profile from the database and cleans up its dedicated userDataDir.
     * Enforces active workspace protection and directory path containment.
     */
    async delete(
      id: string,
      options?: { cleanUserDataDir?: boolean; force?: boolean },
    ): Promise<void> {
      const profile = await deps.profileRepo.getProfile(id);
      if (!profile) {
        throw new WorkspaceNotFoundError(id);
      }

      const lifecycle = deps.lifecycleDelegate;
      if (!lifecycle) {
        throw new WorkspaceValidationError('Workspace process ownership is unavailable');
      }

      await lifecycle.withStoppedProfile(id, { force: options?.force ?? false }, async () => {
        // The lifecycle lease prevents launch while filesystem cleanup and metadata deletion run.
        // A partial cleanup keeps the profile record available for diagnosis and retry.
        if (options?.cleanUserDataDir ?? true) {
          const baseProfilesDir = path.resolve(getProfilesBaseDir());
          const targetDir = path.resolve(profile.userDataDir);
          const contained = (base: string, target: string) => {
            const relative = path.relative(base, target);
            return (
              relative !== '' &&
              relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
            );
          };
          try {
            if (!contained(baseProfilesDir, targetDir)) {
              throw new Error('Workspace cleanup target is outside its managed profile directory');
            }
            if (fs.lstatSync(targetDir, { throwIfNoEntry: false })) {
              const resolvedBase = fs.realpathSync(baseProfilesDir);
              const resolvedTarget = fs.realpathSync(targetDir);
              if (!contained(resolvedBase, resolvedTarget)) {
                throw new Error(
                  'Workspace cleanup target resolves outside its managed profile directory',
                );
              }
              fs.rmSync(targetDir, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 100,
              });
            }
          } catch (error) {
            throw new WorkspaceDirectoryError(profile.userDataDir, error, 'remove');
          }
        }
        await deps.profileRepo.deleteProfile(id);
      });
    },

    /**
     * Launches the workspace profile via lifecycle delegate and records launch timestamp.
     */
    async launch(id: string): Promise<{ pid: number }> {
      return await launchProfile(id);
    },

    /**
     * Finds or creates an isolated workspace profile for the given Google account and launches it.
     * Injects credentials and spawns the isolated IDE via WorkspaceLifecycleService.
     */
    async launchForAccount(accountId: string): Promise<{ pid: number }> {
      const normalizedAccountId = (accountId ?? '').trim();
      if (!normalizedAccountId) {
        throw new AccountNotFoundError(accountId);
      }

      const existingLaunch = inFlightLaunchesByAccount.get(normalizedAccountId);
      if (existingLaunch) {
        return await existingLaunch;
      }

      const executeLaunch = async (): Promise<{ pid: number }> => {
        // 1. Verify bound Google account exists
        const account = await deps.cloudAccountRepo.getAccount(normalizedAccountId);
        if (!account) {
          throw new AccountNotFoundError(normalizedAccountId);
        }

        // 2. Find existing profiles bound to this account
        const existingProfiles = await deps.profileRepo.getProfilesByAccountId(account.id);
        let targetProfile: WorkspaceProfile;

        if (existingProfiles.length > 0) {
          // Prioritize most recently launched, then most recently created
          const sorted = [...existingProfiles].sort((a, b) => {
            const aTime = a.lastLaunchedAt ?? a.createdAt;
            const bTime = b.lastLaunchedAt ?? b.createdAt;
            return bTime - aTime;
          });
          targetProfile = sorted[0];
        } else {
          // Sanitize name: remove all control characters (\x00-\x1F, \x7F), truncate safely to <= 100 chars without severing surrogate pairs
          const rawString = account.name?.trim() || account.email?.trim() || 'Workspace';
          const rawName = rawString
            .split('')
            .map((char) => {
              const code = char.charCodeAt(0);
              return (code >= 0 && code <= 31) || code === 127 ? ' ' : char;
            })
            .join('')
            .trim();
          let truncated = rawName.slice(0, 100);
          if (/[\uD800-\uDBFF]$/.test(truncated)) {
            truncated = truncated.slice(0, -1);
          }
          const defaultName = truncated.trim() || 'Workspace';
          const home = os.homedir();
          const defaultProjectPath =
            home && path.isAbsolute(home) && fs.existsSync(home) ? home : path.resolve('.');
          targetProfile = await deps.profileRepo.createProfile({
            name: defaultName,
            accountId: account.id,
            projectPath: defaultProjectPath,
          });
        }

        return await launchProfile(targetProfile.id);
      };

      const launchPromise = executeLaunch();
      inFlightLaunchesByAccount.set(normalizedAccountId, launchPromise);
      try {
        return await launchPromise;
      } finally {
        inFlightLaunchesByAccount.delete(normalizedAccountId);
      }
    },

    /**
     * Stops the workspace profile process tree via lifecycle delegate.
     */
    async stop(id: string): Promise<void> {
      const profile = await deps.profileRepo.getProfile(id);
      if (!profile) {
        throw new WorkspaceNotFoundError(id);
      }

      if (deps.lifecycleDelegate) {
        await deps.lifecycleDelegate.stop(id);
      }
    },

    /**
     * Synchronizes and self-heals conversations, skills, and extensions across all workspace profiles.
     */
    async syncAll(): Promise<SyncWorkspaceProfilesResult> {
      return await reconcileAllWorkspaceProfiles({
        profileRepo: deps.profileRepo,
      });
    },
  };
}

import { WorkspaceLifecycleService } from './workspace-lifecycle.service';

/** Default singleton instance wired with default repositories and runtime lifecycle delegate */
export const WorkspaceProfileService = createWorkspaceProfileService({
  profileRepo: WorkspaceProfileRepo,
  cloudAccountRepo: defaultCloudAccountRepo,
  get lifecycleDelegate() {
    return WorkspaceLifecycleService;
  },
});
