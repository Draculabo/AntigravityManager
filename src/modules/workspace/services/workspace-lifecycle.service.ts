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
  WorkspaceRestartError,
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

  const readProfile = async (id: string): Promise<WorkspaceProfile> => {
    const profile = await getProfileRepo().getProfile(id);
    if (!profile) {
      throw new WorkspaceNotFoundError(id);
    }
    return profile;
  };
  const startProfile = async (profile: WorkspaceProfile): Promise<{ pid: number }> => {
    const isolatedHome = path.join(profile.userDataDir, 'home');
    const context = await prepareLaunchContext('ide', {
      userDataDir: profile.userDataDir,
      projectPath: profile.projectPath,
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
    const account = await getCloudAccountRepo().getAccount(profile.accountId);
    if (!account) {
      throw new WorkspaceValidationError(
        `Bound Google account "${profile.accountId}" not found in account pool`,
      );
    }

    const storageDir = path.join(profile.userDataDir, 'User', 'globalStorage');
    fs.mkdirSync(storageDir, { recursive: true });

    const credentials: ClientAccountCredentials = {
      email: account.email,
      name: account.name || account.email,
      token: account.token,
    };

    const preparedWrite = await prepareClientAccountWrite(credentials, 'ide', context.pathOptions);
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
      `Provisioned credentials into workspace profile ${profile.id} (${profile.userDataDir})`,
    );

    const sharing = provisionWorkspaceProfileSharing({
      profileUserDataDir: profile.userDataDir,
      isolatedHome,
      pathOptions: {
        isWsl: context.pathOptions.isWsl,
        executablePath: context.executablePath,
        ignoreRunningProcessCache: true,
      },
    });
    if (!sharing.complete) {
      logger.warn('Workspace started with incomplete optional customization sharing', {
        profileId: profile.id,
        failedSteps: sharing.failedSteps,
      });
    }

    const result = await startFromContext({
      ...context,
      extensionsDir: getAntigravityExtensionsDir(context.pathOptions),
    });

    logger.info(
      `Launched workspace profile ${profile.name} (${profile.id}) with PID ${result.pid}`,
    );
    return { pid: result.pid };
  };
  const statuses = async (profiles: WorkspaceProfile[]): Promise<WorkspaceProfileStatus[]> => {
    if (!profiles.length) {
      return [];
    }
    try {
      const processes = await observeProcesses('ide');
      return profiles.map((profile) => {
        const target = canonicalPath(profile.userDataDir);
        const process = processes.find((item) => {
          try {
            const directory = getProcessUserDataDir(item);
            return directory !== null && canonicalPath(directory) === target;
          } catch {
            return false;
          }
        });
        return process ? { running: true, pid: process.pid } : { running: false };
      });
    } catch (error) {
      logger.warn('Workspace process observation unavailable', error);
      return profiles.map(() => ({ running: false, unknown: true }));
    }
  };

  return {
    getStatuses: statuses,
    async getStatus(profile) {
      return (await statuses([profile]))[0];
    },
    async launch(profileId) {
      const profile = await readProfile(profileId);
      return runProcessOperation(
        'ide',
        'starting',
        async () => {
          const current = await readProfile(profileId);
          if (canonicalPath(current.userDataDir) !== canonicalPath(profile.userDataDir)) {
            throw new WorkspaceValidationError('Workspace directory changed before launch');
          }
          return startProfile(current);
        },
        { userDataDir: profile.userDataDir },
      );
    },
    async applyUpdate(profileId, input, persist) {
      const profile = await readProfile(profileId);
      return runProcessOperation(
        'ide',
        'stopping',
        async () => {
          const current = await readProfile(profileId);
          const changesRuntime =
            (input.accountId !== undefined && input.accountId !== current.accountId) ||
            (input.projectPath !== undefined && input.projectPath !== current.projectPath);
          let wasRunning = false;
          if (changesRuntime) {
            const context = await prepareLaunchContext('ide', { userDataDir: current.userDataDir });
            wasRunning = context.processes.length > 0;
            if (wasRunning) {
              await stopFromContext(context, undefined, { forceAfterTimeout: true });
            }
          }
          const updated = await persist();
          // Saved metadata survives a failed or uncertain restart; never dispatch a second instance automatically.
          if (wasRunning) {
            try {
              await startProfile(updated);
            } catch (error) {
              logger.warn('Saved workspace settings but restart was not confirmed', {
                profileId,
                error,
              });
              throw new WorkspaceRestartError(error);
            }
          }
          return updated;
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
