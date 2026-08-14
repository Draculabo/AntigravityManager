import {
  buildGitHubReleaseFromLatestRedirect,
  buildGitHubReleaseFromUpdaterJson,
  buildManualUpdateInfo,
} from './manualUpdatePolicy';
import type {
  GitHubRelease,
  ManualUpdateCheckResult,
  ManualUpdatePlatform,
  ManualUpdateSnooze,
  UpdaterJson,
} from './types';
import { getAppSetting, setAppSetting } from '@/shared/persistence/appSettingsStore';
import { logger } from '@/shared/logging/logger';

const LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/Draculabo/AntigravityManager/releases/latest';
const LATEST_RELEASE_UPDATER_JSON_URL =
  'https://github.com/Draculabo/AntigravityManager/releases/latest/download/updater.json';
const LATEST_RELEASE_REDIRECT_URL =
  'https://github.com/Draculabo/AntigravityManager/releases/latest';
const MANUAL_UPDATE_SNOOZE_KEY = 'manual_update_snooze';
const MANUAL_UPDATE_MOCK_VERSION = '9.9.9';

function isManualUpdatePlatform(platform: NodeJS.Platform): platform is ManualUpdatePlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

export function getManualUpdateSnooze(): ManualUpdateSnooze | null {
  return getAppSetting<ManualUpdateSnooze | null>(MANUAL_UPDATE_SNOOZE_KEY, null);
}

export function snoozeManualUpdate(version: string): void {
  setAppSetting(MANUAL_UPDATE_SNOOZE_KEY, {
    version,
    dismissedAt: new Date().toISOString(),
  });
}

export function isManualUpdateMockEnabled(): boolean {
  return process.env.MANUAL_UPDATE_MOCK === '1';
}

export function isManualUpdateForceEnabled(): boolean {
  return process.env.MANUAL_UPDATE_FORCE === '1';
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'AntigravityManager',
      ...headers,
    },
  });

  if (!response.ok) {
    logger.warn(`ManualUpdate: ${url} returned status ${response.status}`);
    return null;
  }

  return (await response.json()) as T;
}

async function fetchLatestReleaseFromUpdaterJson(): Promise<GitHubRelease | null> {
  const updaterJson = await fetchJson<UpdaterJson>(LATEST_RELEASE_UPDATER_JSON_URL);
  if (!updaterJson) {
    return null;
  }

  return buildGitHubReleaseFromUpdaterJson(updaterJson);
}

async function fetchLatestReleaseFromGitHubApi(): Promise<GitHubRelease | null> {
  return fetchJson<GitHubRelease>(LATEST_RELEASE_API_URL, {
    Accept: 'application/vnd.github+json',
  });
}

async function fetchLatestReleaseFromRedirect(): Promise<GitHubRelease | null> {
  const response = await fetch(LATEST_RELEASE_REDIRECT_URL, {
    headers: {
      'User-Agent': 'AntigravityManager',
    },
  });

  if (!response.ok) {
    return null;
  }

  return buildGitHubReleaseFromLatestRedirect(response.url);
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const sources: Array<[string, () => Promise<GitHubRelease | null>]> = [
    ['updater.json', fetchLatestReleaseFromUpdaterJson],
    ['GitHub API', fetchLatestReleaseFromGitHubApi],
    ['GitHub latest redirect', fetchLatestReleaseFromRedirect],
  ];

  for (const [sourceName, fetchSource] of sources) {
    try {
      const release = await fetchSource();
      if (release) {
        logger.info(`ManualUpdate: Latest release resolved from ${sourceName}`);
        return release;
      }
    } catch (error) {
      logger.warn(
        `ManualUpdate: ${sourceName} check failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  return null;
}

export async function checkManualUpdate(currentVersion: string): Promise<ManualUpdateCheckResult> {
  const platform =
    isManualUpdateMockEnabled() || isManualUpdateForceEnabled() ? 'linux' : process.platform;
  if (!isManualUpdatePlatform(platform)) {
    return { status: 'unsupported' };
  }

  if (isManualUpdateMockEnabled()) {
    return {
      status: 'available',
      update: {
        version: MANUAL_UPDATE_MOCK_VERSION,
        tagName: `v${MANUAL_UPDATE_MOCK_VERSION}`,
        releaseName: 'Mock Release',
        releaseUrl: `https://github.com/Draculabo/AntigravityManager/releases/tag/v${MANUAL_UPDATE_MOCK_VERSION}`,
        platform,
      },
    };
  }

  try {
    const release = await fetchLatestRelease();
    if (!release) {
      return {
        status: 'error',
        message: 'GitHub release check failed',
      };
    }
    console.dir('github release' + JSON.stringify(release));

    const update = buildManualUpdateInfo({
      currentVersion,
      platform,
      release,
    });

    if (!update) {
      return { status: 'up-to-date' };
    }

    return {
      status: 'available',
      update,
    };
  } catch (error) {
    logger.error('ManualUpdate: Failed to check GitHub Releases', error);
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown update check error',
    };
  }
}
