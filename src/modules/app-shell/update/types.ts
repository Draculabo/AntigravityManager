import { z } from 'zod';

export type ManualUpdatePlatform = 'darwin' | 'linux' | 'win32';
export type UpdateNotificationSource = 'manual' | 'electron-updater';
export type UpdateNotificationState = 'available' | 'downloading' | 'downloaded' | 'error';

export const GitHubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string().nullable(),
  html_url: z.url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

export const UpdaterJsonSchema = z.object({
  version: z.string().min(1),
  notes: z.string().optional(),
  pub_date: z.string().optional(),
  url: z.url().optional(),
});

export type UpdaterJson = z.infer<typeof UpdaterJsonSchema>;

export const PackageJsonVersionSchema = z.object({
  version: z.string().min(1),
});

export type PackageJsonVersion = z.infer<typeof PackageJsonVersionSchema>;

export interface ManualUpdateInfo {
  version: string;
  tagName: string;
  releaseName: string;
  releaseUrl: string;
  platform: ManualUpdatePlatform;
  source?: UpdateNotificationSource;
  state?: UpdateNotificationState;
  downloadPercent?: number;
}

export interface ManualUpdateSnooze {
  version: string;
  dismissedAt: string;
}

export const ManualUpdateSnoozeSchema = z.object({
  version: z.string().min(1),
  dismissedAt: z.iso.datetime(),
});

export type ManualUpdateCheckResult =
  | {
      status: 'available';
      update: ManualUpdateInfo;
    }
  | {
      status: 'up-to-date';
    }
  | {
      status: 'unsupported';
    }
  | {
      status: 'error';
      message: string;
    };
