import fs from 'node:fs';
import os from 'node:os';
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
  ActiveWorkspaceDeletionError,
  WorkspaceValidationError,
  type WorkspaceLifecycleDelegate,
  type WorkspaceProfile,
  type WorkspaceProfileStatus,
} from '../types';
import { getAntigravityExtensionsDir } from '@/shared/platform/paths';
import { provisionWorkspaceProfileSharing } from './workspace-provisioning';

export interface WorkspaceLifecycleServiceDependencies {
  profileRepo?: Pick<typeof WorkspaceProfileRepo, 'getProfile'>;
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

      return runProcessOperation(
        'ide',
        'starting',
        async () => {
          const currentProfile = await getProfileRepo().getProfile(profileId);
          if (!currentProfile) {
            throw new WorkspaceNotFoundError(profileId);
          }
          if (canonicalPath(currentProfile.userDataDir) !== canonicalPath(profile.userDataDir)) {
            throw new WorkspaceValidationError('Workspace directory changed before launch');
          }
          const accountId = currentProfile.accountId;
          const isolatedHome = path.join(profile.userDataDir, 'home');
          const context = await prepareLaunchContext('ide', {
            userDataDir: profile.userDataDir,
            projectPath: currentProfile.projectPath,
            extensionsDir: getAntigravityExtensionsDir(),
            env: {
              HOME: isolatedHome,
              ...(process.platform === 'win32' ? { USERPROFILE: isolatedHome } : {}),
              DBUS_SESSION_BUS_ADDRESS: 'disabled:',
            },
          });
          if (context.processes.length) {
            return { pid: context.processes[0].pid };
          }

          // Fetch bound Google account
          const account = await getCloudAccountRepo().getAccount(accountId);
          if (!account) {
            throw new WorkspaceValidationError(
              `Bound Google account "${accountId}" not found in account pool`,
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

          const preparedWrite = await prepareClientAccountWrite(
            credentials,
            'ide',
            context.pathOptions,
          );
          await preparedWrite.write();

          fs.mkdirSync(isolatedHome, { recursive: true });

          // Link developer shell configuration from host user home if present
          const hostHome = os.homedir();
          for (const dotfile of ['.gitconfig', '.ssh', '.bashrc', '.zshrc', '.profile']) {
            const src = path.join(hostHome, dotfile);
            const dest = path.join(isolatedHome, dotfile);
            if (fs.existsSync(src) && !fs.existsSync(dest)) {
              try {
                fs.symlinkSync(src, dest);
              } catch {
                // Ignore symlink failure across filesystems or permission boundaries
              }
            }
          }

          logger.info(
            `Provisioned credentials into workspace profile ${profileId} (${profile.userDataDir})`,
          );

          // 4. Provision workspace profile sharing: extensions, editor settings, agent skills, and recent history
          provisionWorkspaceProfileSharing({
            profileUserDataDir: profile.userDataDir,
            isolatedHome,
          });

          const result = await startFromContext(context);

          logger.info(
            `Launched workspace profile ${profile.name} (${profileId}) with PID ${result.pid}`,
          );
          return { pid: result.pid };
        },
        { userDataDir: profile.userDataDir },
      );
    },

    async stop(profileId: string): Promise<void> {
      const profile = await getProfileRepo().getProfile(profileId);
      if (!profile) {
        throw new WorkspaceNotFoundError(profileId);
      }

      await runProcessOperation(
        'ide',
        'stopping',
        async () => {
          const context = await prepareLaunchContext('ide', {
            userDataDir: profile.userDataDir,
          });
          await stopFromContext(context);
        },
        { userDataDir: profile.userDataDir },
      );

      logger.info(`Stopped workspace profile ${profile.name} (${profileId})`);
    },

    async withStoppedProfile(profileId, options, action): Promise<void> {
      const profile = await getProfileRepo().getProfile(profileId);
      if (!profile) {
        throw new WorkspaceNotFoundError(profileId);
      }
      await runProcessOperation(
        'ide',
        'stopping',
        async () => {
          const context = await prepareLaunchContext('ide', { userDataDir: profile.userDataDir });
          if (context.processes.length) {
            if (!options.force) {
              throw new ActiveWorkspaceDeletionError(profileId);
            }
            await stopFromContext(context);
          }
          await action();
        },
        { userDataDir: profile.userDataDir },
      );
    },
  };
}

export const WorkspaceLifecycleService = createWorkspaceLifecycleService();
