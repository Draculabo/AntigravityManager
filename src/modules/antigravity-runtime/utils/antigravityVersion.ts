import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { compare, coerce, parse } from 'semver';
import { getAntigravityExecutablePath, isWsl } from '@/shared/platform/paths';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { resolveAntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';

export interface AntigravityVersion {
  shortVersion: string;
  bundleVersion: string;
}

const cachedVersions = new Map<AntigravityAppTarget, AntigravityVersion>();
const cachedErrors = new Map<AntigravityAppTarget, Error>();

function cacheAndReturn(
  target: AntigravityAppTarget,
  version: AntigravityVersion,
): AntigravityVersion {
  cachedVersions.set(target, version);
  return version;
}

function readPackageJsonVersion(execPath: string): AntigravityVersion | null {
  const parentDir = path.dirname(execPath);
  const packageJson = path.join(parentDir, 'resources', 'app', 'package.json');
  if (!fs.existsSync(packageJson)) {
    return null;
  }
  try {
    const content = fs.readFileSync(packageJson, 'utf-8');
    const json = JSON.parse(content) as { version?: string };
    const parsed = parseVersionString(json.version || null);
    return {
      shortVersion: parsed,
      bundleVersion: parsed,
    };
  } catch {
    return null;
  }
}

function readPlistValue(content: string, key: string): string | null {
  const pattern = new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`, 'i');
  const match = content.match(pattern);
  if (match) {
    return match[1].trim();
  }
  return null;
}

function parseVersionString(version: string | null): string {
  if (!version) {
    throw new Error('Version information not found');
  }
  const trimmed = version.trim();
  if (!trimmed) {
    throw new Error('Version information is empty');
  }
  return trimmed;
}

export function getAntigravityVersion(target?: AntigravityAppTarget | null): AntigravityVersion {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const cachedVersion = cachedVersions.get(resolvedTarget);
  if (cachedVersion) {
    return cachedVersion;
  }
  const cachedError = cachedErrors.get(resolvedTarget);
  if (cachedError) {
    throw cachedError;
  }

  try {
    const execPath = getAntigravityExecutablePath(resolvedTarget);
    if (!execPath) {
      throw new Error('Unable to locate Antigravity executable');
    }

    if (process.platform === 'win32') {
      try {
        const escapedPath = execPath.replace(/'/g, "''");
        const command = `(Get-Item '${escapedPath}').VersionInfo.FileVersion`;
        const version = execSync(`powershell -NoProfile -Command "${command}"`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        const parsed = parseVersionString(version);
        return cacheAndReturn(resolvedTarget, {
          shortVersion: parsed,
          bundleVersion: parsed,
        });
      } catch (error) {
        const fallback = readPackageJsonVersion(execPath);
        if (fallback) {
          return cacheAndReturn(resolvedTarget, fallback);
        }
        throw error;
      }
    }

    if (process.platform === 'darwin') {
      const appIndex = execPath.toLowerCase().indexOf('.app');
      const appPath = appIndex >= 0 ? execPath.slice(0, appIndex + 4) : execPath;
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      if (!fs.existsSync(plistPath)) {
        throw new Error(`Info.plist not found: ${plistPath}`);
      }

      let content = fs.readFileSync(plistPath, 'utf-8');
      if (content.startsWith('bplist')) {
        try {
          content = execSync(`plutil -convert xml1 -o - "${plistPath}"`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch {
          throw new Error('Failed to parse Info.plist');
        }
      }

      const shortVersion = parseVersionString(
        readPlistValue(content, 'CFBundleShortVersionString'),
      );
      const bundleVersion = parseVersionString(
        readPlistValue(content, 'CFBundleVersion') || shortVersion,
      );

      return cacheAndReturn(resolvedTarget, {
        shortVersion,
        bundleVersion,
      });
    }

    if (process.platform === 'linux') {
      // Under WSL the resolved executable is the Windows build, and running it
      // does not print a version and exit: the interop launch hands the request
      // to Antigravity itself, which opens a window on the user's desktop. The
      // version is readable from the package manifest beside the binary, so ask
      // the file rather than the process.
      if (isWsl()) {
        const manifestVersion = readPackageJsonVersion(execPath);
        if (manifestVersion) {
          return cacheAndReturn(resolvedTarget, manifestVersion);
        }
        throw new Error(`Unable to read Antigravity version from ${execPath} under WSL`);
      }

      try {
        const output = execSync(`"${execPath}" --version`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const parsed = parseVersionString(output);
        return cacheAndReturn(resolvedTarget, {
          shortVersion: parsed,
          bundleVersion: parsed,
        });
      } catch {
        const fallback = readPackageJsonVersion(execPath);
        if (fallback) {
          return cacheAndReturn(resolvedTarget, fallback);
        }
      }
    }

    throw new Error('Unable to determine Antigravity version');
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error('Unable to determine Antigravity version');
    cachedErrors.set(resolvedTarget, normalized);
    throw normalized;
  }
}

export function compareVersion(v1: string, v2: string): number {
  const parsedV1 = parse(v1.trim()) ?? coerce(v1);
  const parsedV2 = parse(v2.trim()) ?? coerce(v2);

  if (!parsedV1 && !parsedV2) {
    return 0;
  }
  if (!parsedV1) {
    return -1;
  }
  if (!parsedV2) {
    return 1;
  }

  return compare(parsedV1, parsedV2);
}

export function isNewVersion(version: AntigravityVersion): boolean {
  return compareVersion(version.shortVersion, '1.16.5') >= 0;
}

export function isCredentialStoreVersion(version: AntigravityVersion): boolean {
  return compareVersion(version.shortVersion, '2.0.0') >= 0;
}
