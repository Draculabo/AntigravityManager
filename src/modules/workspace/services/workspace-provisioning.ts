import path from 'node:path';
import {
  getAppDataDir,
  getAntigravityExtensionsDir,
  getAntigravityHostUserDir,
  type PathResolutionOptions,
} from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { WorkspaceProfileRepo } from '../persistence/workspace-profile-repo';
import {
  ActiveWorkspaceDeletionError,
  type WorkspaceLifecycleDelegate,
  type WorkspaceProfile,
  type SyncWorkspaceProfilesResult,
} from '../types';
import { provisionEditorSettings, provisionExtensionsSharing } from './workspace-sharing-files';
import { provisionGeminiCustomizations } from './workspace-sharing-gemini';
import { seedRecentProjectHistory } from './workspace-sharing-history';

export {
  isPathAbsent,
  safeSymlink,
  provisionEditorSettings,
  provisionExtensionsSharing,
} from './workspace-sharing-files';
export {
  isStaleOrScaffoldGeminiDir,
  provisionGeminiCustomizations,
} from './workspace-sharing-gemini';
export {
  resolveHostStateDbPath,
  resolveHostUserDir,
  seedRecentProjectHistory,
  type HistorySeedingOptions,
} from './workspace-sharing-history';

export interface WorkspaceProfileSharingOptions {
  profileUserDataDir: string;
  isolatedHome: string;
  hostUserDir?: string;
  hostGeminiDir?: string;
  hostExtensionsDir?: string;
  hostDbPath?: string;
  pathOptions?: PathResolutionOptions;
}

export interface WorkspaceSharingResult {
  complete: boolean;
  failedSteps: Array<'extensions' | 'settings' | 'customizations' | 'history'>;
}

/** Optional customization failure does not prevent startup, but must remain observable. */
export function provisionWorkspaceProfileSharing(
  options: WorkspaceProfileSharingOptions,
): WorkspaceSharingResult {
  const failedSteps: WorkspaceSharingResult['failedSteps'] = [];
  try {
    const profile = path.resolve(options.profileUserDataDir);
    if (
      ['classic', 'ide'].some(
        (target) =>
          profile ===
          path.resolve(getAppDataDir(target === 'ide' ? 'ide' : 'classic', options.pathOptions)),
      )
    ) {
      return { complete: true, failedSteps };
    }
    const steps = [
      [
        'extensions',
        () =>
          provisionExtensionsSharing(
            options.profileUserDataDir,
            options.isolatedHome,
            options.hostExtensionsDir ?? getAntigravityExtensionsDir(options.pathOptions),
          ),
      ],
      [
        'settings',
        () =>
          provisionEditorSettings(
            options.profileUserDataDir,
            options.hostUserDir ?? getAntigravityHostUserDir(options.pathOptions),
          ),
      ],
      [
        'customizations',
        () => provisionGeminiCustomizations(options.isolatedHome, options.hostGeminiDir),
      ],
      [
        'history',
        () =>
          seedRecentProjectHistory({
            profileUserDataDir: options.profileUserDataDir,
            hostDbPath: options.hostDbPath,
            pathOptions: options.pathOptions,
          }),
      ],
    ] satisfies Array<[WorkspaceSharingResult['failedSteps'][number], () => boolean]>;
    for (const [step, action] of steps) {
      try {
        if (!action()) {
          failedSteps.push(step);
        }
      } catch (error) {
        logger.warn('Workspace customization step failed', { step, error });
        failedSteps.push(step);
      }
    }
  } catch (error) {
    logger.warn('Workspace customization preparation failed', error);
    failedSteps.push('settings');
  }
  return { complete: failedSteps.length === 0, failedSteps };
}

export interface ReconcileAllProfilesOptions extends Omit<
  WorkspaceProfileSharingOptions,
  'profileUserDataDir' | 'isolatedHome'
> {
  profileRepo?: { listProfiles(options?: { dbPath?: string }): Promise<WorkspaceProfile[]> };
  dbPath?: string;
  withStoppedProfile: WorkspaceLifecycleDelegate['withStoppedProfile'];
}

export type ReconcileProfilesResult = SyncWorkspaceProfilesResult;

/** Reconcile stopped profiles under the same lease used by launch and deletion. */
export async function reconcileAllWorkspaceProfiles(
  options: ReconcileAllProfilesOptions,
): Promise<ReconcileProfilesResult> {
  const profiles = await (options.profileRepo ?? WorkspaceProfileRepo).listProfiles({
    dbPath: options.dbPath,
  });
  const result: ReconcileProfilesResult = { reconciledCount: 0, profiles: [] };
  for (const profile of profiles) {
    try {
      await options.withStoppedProfile(profile.id, { force: false }, async () => {
        const shared = provisionWorkspaceProfileSharing({
          ...options,
          profileUserDataDir: profile.userDataDir,
          isolatedHome: path.join(profile.userDataDir, 'home'),
        });
        result.profiles.push({
          id: profile.id,
          name: profile.name,
          reconciled: shared.complete,
          ...(shared.complete ? {} : { reason: 'sharing-failed' as const }),
        });
        if (shared.complete) {
          result.reconciledCount++;
        }
      });
    } catch (error) {
      result.profiles.push({
        id: profile.id,
        name: profile.name,
        reconciled: false,
        reason: error instanceof ActiveWorkspaceDeletionError ? 'running' : 'unavailable',
      });
      logger.warn('Workspace synchronization deferred', { profileId: profile.id, error });
    }
  }
  return result;
}
