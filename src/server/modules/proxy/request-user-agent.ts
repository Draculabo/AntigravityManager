import axios from 'axios';
import { isString } from 'lodash-es';
import { getAntigravityVersion } from '../../../utils/antigravityVersion';
import { logger } from '../../../utils/logger';

const REMOTE_VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const CHANGELOG_URL = 'https://antigravity.google/changelog';
export const FALLBACK_VERSION = '1.22.2';
const DEFAULT_REMOTE_TIMEOUT_MS = 2500;
const VERSION_REGEX = /\d+\.\d+\.\d+/g;

type UserAgentSource = 'local' | 'remote' | 'changelog' | 'fallback';

interface UserAgentResolution {
  source: UserAgentSource;
  userAgent: string;
  version: string;
}

let cachedUserAgentResolution: UserAgentResolution | null = null;
let pendingUserAgentResolution: Promise<UserAgentResolution> | null = null;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (!isString(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function getPlatformTag(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

function getArchTag(): string {
  if (process.arch === 'x64') {
    return 'amd64';
  }

  if (process.arch === 'arm64') {
    return 'arm64';
  }

  return process.arch;
}

export function buildUserAgent(version: string): string {
  return `antigravity/${version} ${getPlatformTag()}/${getArchTag()}`;
}

function compareSemverVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function extractHighestSemver(text: string): string | null {
  const matches = text.match(VERSION_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }

  let best = matches[0];
  for (const candidate of matches) {
    if (compareSemverVersions(candidate, best) > 0) {
      best = candidate;
    }
  }

  return best;
}

function shouldSkipRemoteVersionLookup(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

export function resolveLocalInstalledVersion(): string | null {
  let localVersionString: string;
  try {
    localVersionString = getAntigravityVersion().shortVersion;
    const rawVersion = normalizeNonEmptyString(localVersionString);
    if (!rawVersion) {
      return null;
    }
  } catch {
    return null;
  }

  return extractHighestSemver(localVersionString);
}

async function fetchTextPayload(url: string): Promise<string | null> {
  try {
    const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
    const response = await axios.get<string>(url, {
      timeout: DEFAULT_REMOTE_TIMEOUT_MS,
      responseType: 'text',
      headers: {
        'User-Agent': buildUserAgent(discoveryVersion),
      },
    });

    if (isString(response.data)) {
      return response.data;
    }

    return JSON.stringify(response.data);
  } catch {
    return null;
  }
}

async function resolveRemoteVersion(): Promise<{
  source: Extract<UserAgentSource, 'remote' | 'changelog'>;
  version: string;
} | null> {
  if (shouldSkipRemoteVersionLookup()) {
    return null;
  }

  const remotePayload = await fetchTextPayload(REMOTE_VERSION_URL);
  if (remotePayload) {
    const parsed = extractHighestSemver(remotePayload);
    if (parsed) {
      return {
        source: 'remote',
        version: parsed,
      };
    }
  }

  const changelogPayload = await fetchTextPayload(CHANGELOG_URL);
  if (!changelogPayload) {
    return null;
  }

  const parsed = extractHighestSemver(changelogPayload);
  if (!parsed) {
    return null;
  }

  return {
    source: 'changelog',
    version: parsed,
  };
}

async function resolveDefaultUserAgentResolution(): Promise<UserAgentResolution> {
  let bestVersion = FALLBACK_VERSION;
  let bestSource: UserAgentSource = 'fallback';

  const localVersion = resolveLocalInstalledVersion();
  if (localVersion && compareSemverVersions(localVersion, bestVersion) > 0) {
    bestVersion = localVersion;
    bestSource = 'local';
  }

  const remoteVersion = await resolveRemoteVersion();
  if (remoteVersion && compareSemverVersions(remoteVersion.version, bestVersion) > 0) {
    bestVersion = remoteVersion.version;
    bestSource = remoteVersion.source;
  }

  return {
    source: bestSource,
    version: bestVersion,
    userAgent: buildUserAgent(bestVersion),
  };
}

async function getResolvedDefaultRequestUserAgent(): Promise<string> {
  if (cachedUserAgentResolution) {
    return cachedUserAgentResolution.userAgent;
  }

  if (pendingUserAgentResolution) {
    return (await pendingUserAgentResolution).userAgent;
  }

  pendingUserAgentResolution = resolveDefaultUserAgentResolution()
    .then((resolved) => {
      cachedUserAgentResolution = resolved;
      logger.info(
        `Default request User-Agent resolved (source=${resolved.source}, version=${resolved.version}): ${resolved.userAgent}`,
      );
      return resolved;
    })
    .finally(() => {
      pendingUserAgentResolution = null;
    });

  return (await pendingUserAgentResolution).userAgent;
}

export async function resolveRequestUserAgent(): Promise<string> {
  return await getResolvedDefaultRequestUserAgent();
}
