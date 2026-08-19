import semver from 'semver';
import type {
  GitHubRelease,
  ManualUpdateInfo,
  ManualUpdatePlatform,
  PackageJsonVersion,
  UpdaterJson,
} from './types';

const MANUAL_UPDATE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_TAG_URL_PREFIX = 'https://github.com/Draculabo/AntigravityManager/releases/tag/';
const RELEASE_TAG_PATH_PREFIX = '/Draculabo/AntigravityManager/releases/tag/';

interface BuildManualUpdateInfoInput {
  currentVersion: string;
  platform: ManualUpdatePlatform;
  release: GitHubRelease;
}

interface ManualUpdateSnoozeInput {
  version: string;
  dismissedAt: string;
}

function normalizeStableVersion(version: string): string | null {
  const cleaned = semver.clean(version);
  if (!cleaned) {
    return null;
  }

  if (semver.prerelease(cleaned)) {
    return null;
  }

  return cleaned;
}

function getReleaseTagName(version: string): string | null {
  const cleaned = semver.clean(version);
  if (!cleaned) {
    return null;
  }

  return `v${cleaned}`;
}

function getReleaseUrlForVersion(version: string): string | null {
  const tagName = getReleaseTagName(version);
  if (!tagName) {
    return null;
  }

  return `${RELEASE_TAG_URL_PREFIX}${tagName}`;
}

export function buildGitHubReleaseFromUpdaterJson(updaterJson: UpdaterJson): GitHubRelease | null {
  const tagName = getReleaseTagName(updaterJson.version);
  const fallbackReleaseUrl = getReleaseUrlForVersion(updaterJson.version);
  if (!tagName || !fallbackReleaseUrl) {
    return null;
  }

  return {
    tag_name: tagName,
    name: tagName,
    html_url: updaterJson.url || fallbackReleaseUrl,
    draft: false,
    prerelease: false,
  };
}

export function buildGitHubReleaseFromPackageJson(
  packageJson: PackageJsonVersion,
): GitHubRelease | null {
  const tagName = getReleaseTagName(packageJson.version);
  const releaseUrl = getReleaseUrlForVersion(packageJson.version);
  if (!tagName || !releaseUrl) {
    return null;
  }

  return {
    tag_name: tagName,
    name: tagName,
    html_url: releaseUrl,
    draft: false,
    prerelease: false,
  };
}

export function buildGitHubReleaseFromLatestRedirect(url: string): GitHubRelease | null {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname !== 'github.com' ||
      !parsedUrl.pathname.startsWith(RELEASE_TAG_PATH_PREFIX)
    ) {
      return null;
    }

    const tagName = decodeURIComponent(parsedUrl.pathname.slice(RELEASE_TAG_PATH_PREFIX.length));
    if (!semver.clean(tagName)) {
      return null;
    }

    return {
      tag_name: tagName,
      name: tagName,
      html_url: parsedUrl.toString(),
      draft: false,
      prerelease: false,
    };
  } catch {
    return null;
  }
}

export function buildManualUpdateInfo({
  currentVersion,
  platform,
  release,
}: BuildManualUpdateInfoInput): ManualUpdateInfo | null {
  if (release.draft || release.prerelease) {
    return null;
  }

  const latestVersion = normalizeStableVersion(release.tag_name);
  const normalizedCurrentVersion = semver.clean(currentVersion);
  if (!latestVersion || !normalizedCurrentVersion) {
    return null;
  }

  if (!semver.gt(latestVersion, normalizedCurrentVersion)) {
    return null;
  }

  return {
    version: latestVersion,
    tagName: release.tag_name,
    releaseName: release.name || release.tag_name,
    releaseUrl: release.html_url,
    platform,
  };
}

export function isManualUpdateSnoozed(
  snooze: ManualUpdateSnoozeInput | null,
  version: string,
  now = new Date(),
): boolean {
  if (!snooze || snooze.version !== version) {
    return false;
  }

  const dismissedAt = new Date(snooze.dismissedAt).getTime();
  if (Number.isNaN(dismissedAt)) {
    return false;
  }

  const elapsed = now.getTime() - dismissedAt;
  return elapsed >= 0 && elapsed < MANUAL_UPDATE_SNOOZE_MS;
}
