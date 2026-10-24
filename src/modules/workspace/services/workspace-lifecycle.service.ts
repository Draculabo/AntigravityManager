import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/shared/logging/logger';
import {
  canonicalPath,
  getProcessUserDataDir,
  observeProcesses,
  prepareClientAccountWrite,
  prepareLaunchContext,
  runProcessOperation,
  startFromContext,
  stopFromContext,
  type ClientAccountCredentials,
} from '@/modules/antigravity-runtime';
import { WorkspaceProfileRepo } from '../persistence/workspace-profile-repo';
import { defaultCloudAccountRepo } from './workspace-profile.service';
import {
  WorkspaceNotFoundError,
  WorkspaceValidationError,
  type WorkspaceLifecycleDelegate,
  type WorkspaceProfile,
  type WorkspaceProfileStatus,
} from '../types';

export interface WorkspaceLifecycleServiceDependencies {
  profileRepo?: typeof WorkspaceProfileRepo;
  cloudAccountRepo?: typeof defaultCloudAccountRepo;
}

export function createWorkspaceLifecycleService(
  deps: WorkspaceLifecycleServiceDependencies = {},
): WorkspaceLifecycleDelegate {
  const getProfileRepo = () => deps.profileRepo ?? WorkspaceProfileRepo;
  const getCloudAccountRepo = () => deps.cloudAccountRepo ?? defaultCloudAccountRepo;

  return {
    async getStatus(profile: WorkspaceProfile): Promise<WorkspaceProfileStatus> {
      try {
        const canonicalTarget = canonicalPath(profile.userDataDir);
        const processes = await observeProcesses('ide');
        const match = processes.find((proc) => {
          try {
            const procDir = getProcessUserDataDir(proc);
            if (procDir && canonicalPath(procDir) === canonicalTarget) {
              return true;
            }
            return proc.args.some((arg) => {
              try {
                if (
                  arg === profile.userDataDir ||
                  arg === `--user-data-dir=${profile.userDataDir}`
                ) {
                  return true;
                }
                if (arg.startsWith('--user-data-dir=')) {
                  const val = arg.slice('--user-data-dir='.length);
                  return canonicalPath(val) === canonicalTarget;
                }
                return false;
              } catch {
                return false;
              }
            });
          } catch {
            return false;
          }
        });

        if (match) {
          return { running: true, pid: match.pid };
        }
        return { running: false };
      } catch (error) {
        logger.warn(`Failed to observe processes for workspace profile ${profile.id}`, error);
        return { running: false };
      }
    },

    async launch(profileId: string): Promise<{ pid: number }> {
      const profile = await getProfileRepo().getProfile(profileId);
      if (!profile) {
        throw new WorkspaceNotFoundError(profileId);
      }

      // Check if already running (idempotent launch)
      const currentStatus = await this.getStatus(profile);
      if (currentStatus.running && currentStatus.pid) {
        logger.info(
          `Workspace profile ${profile.name} (${profileId}) is already running (PID: ${currentStatus.pid})`,
        );
        return { pid: currentStatus.pid };
      }

      // Fetch bound Google account
      const account = await getCloudAccountRepo().getAccount(profile.accountId);
      if (!account) {
        throw new WorkspaceValidationError(
          `Bound Google account "${profile.accountId}" not found in account pool`,
        );
      }

      // 1. Prepare profile environment & inject SQLite credentials
      const storageDir = path.join(profile.userDataDir, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });

      const credentials: ClientAccountCredentials = {
        email: account.email,
        name: account.name || account.email,
        token: account.token,
      };

      const preparedWrite = await prepareClientAccountWrite(credentials, 'ide', {
        userDataDir: profile.userDataDir,
      });
      await preparedWrite.write();
      logger.info(
        `Provisioned credentials into workspace profile ${profileId} (${profile.userDataDir})`,
      );

      // 2. Prepare launch context targeting profile userDataDir and projectPath
      const context = await prepareLaunchContext('ide', {
        userDataDir: profile.userDataDir,
        projectPath: profile.projectPath,
      });

      // 3. Dispatch launch inside scoped process operation lock
      const result = await runProcessOperation(
        'ide',
        'starting',
        async () => {
          return await startFromContext(context);
        },
        { userDataDir: profile.userDataDir },
      );

      logger.info(
        `Launched workspace profile ${profile.name} (${profileId}) with PID ${result.pid}`,
      );
      return { pid: result.pid };
    },

    async stop(profileId: string): Promise<void> {
      const profile = await getProfileRepo().getProfile(profileId);
      if (!profile) {
        throw new WorkspaceNotFoundError(profileId);
      }

      const currentStatus = await this.getStatus(profile);
      if (!currentStatus.running) {
        return;
      }

      const context = await prepareLaunchContext('ide', {
        userDataDir: profile.userDataDir,
      });

      await runProcessOperation(
        'ide',
        'stopping',
        async () => {
          await stopFromContext(context);
        },
        { userDataDir: profile.userDataDir },
      );

      logger.info(`Stopped workspace profile ${profile.name} (${profileId})`);
    },
  };
}

export const WorkspaceLifecycleService = createWorkspaceLifecycleService();
