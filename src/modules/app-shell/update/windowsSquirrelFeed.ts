import path from 'node:path';
import axios from 'axios';
import semver from 'semver';

const RELEASES_LIMIT = 64 * 1024;
const PACKAGE_ID = 'antigravity_manager';

export function findLatestSquirrelVersion(
  releases: string,
  currentVersion: string,
  arch: NodeJS.Architecture,
): string | null {
  const suffix = arch === 'arm64' ? '-arm64-full.nupkg' : '-full.nupkg';
  const prefix = `${PACKAGE_ID}-`;
  let latest: string | null = null;
  for (const line of releases.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{40})\s+(\S+)\s+(\d+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    let filename: string;
    try {
      filename = path.posix.basename(new URL(match[2], 'https://invalid.example').pathname);
    } catch {
      continue;
    }
    if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) {
      continue;
    }
    const candidate = filename.slice(prefix.length, -suffix.length);
    if (!semver.valid(candidate) || semver.prerelease(candidate)) {
      continue;
    }
    if (arch === 'x64' && candidate.endsWith('-arm64')) {
      continue;
    }
    if (semver.gt(candidate, currentVersion) && (!latest || semver.gt(candidate, latest))) {
      latest = candidate;
    }
  }
  return latest;
}

export async function readSquirrelReleases(feedUrl: string): Promise<string> {
  const url = new URL('RELEASES', `${feedUrl.replace(/\/+$/, '')}/`);
  const response = await axios.get<string>(url.toString(), {
    responseType: 'text',
    timeout: 10_000,
    maxContentLength: RELEASES_LIMIT,
    headers: { 'Cache-Control': 'no-cache' },
    validateStatus: (status) => status === 200,
  });
  if (typeof response.data !== 'string' || Buffer.byteLength(response.data) > RELEASES_LIMIT) {
    throw new Error('Squirrel release index exceeds the size limit');
  }
  return response.data;
}
