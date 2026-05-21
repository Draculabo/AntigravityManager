import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getAntigravityExecutablePath } from './paths';

export interface AntigravityVersion {
  shortVersion: string;
  bundleVersion: string;
}

let cachedVersion: AntigravityVersion | null = null;
let cachedError: Error | null = null;

function cacheAndReturn(version: AntigravityVersion): AntigravityVersion {
  cachedVersion = version;
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

export function getAntigravityVersion(): AntigravityVersion {
  if (cachedVersion) {
    return cachedVersion;
  }
  if (cachedError) {
    throw cachedError;
  }

  try {
    const execPath = getAntigravityExecutablePath();
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
        return cacheAndReturn({
          shortVersion: parsed,
          bundleVersion: parsed,
        });
      } catch (error) {
        const fallback = readPackageJsonVersion(execPath);
        if (fallback) {
          return cacheAndReturn(fallback);
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

      return cacheAndReturn({
        shortVersion,
        bundleVersion,
      });
    }

    if (process.platform === 'linux') {
      try {
        const output = execSync(`"${execPath}" --version`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const parsed = parseVersionString(output);
        return cacheAndReturn({
          shortVersion: parsed,
          bundleVersion: parsed,
        });
      } catch {
        const fallback = readPackageJsonVersion(execPath);
        if (fallback) {
          return cacheAndReturn(fallback);
        }
      }
    }

    throw new Error('Unable to determine Antigravity version');
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error('Unable to determine Antigravity version');
    cachedError = normalized;
    throw normalized;
  }
}

export function compareVersion(v1: string, v2: string): number {
  const parts1 = v1
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => !Number.isNaN(value));
  const parts2 = v2
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => !Number.isNaN(value));
  const length = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < length; i += 1) {
    const left = parts1[i] ?? 0;
    const right = parts2[i] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }
  return 0;
}

export function isNewVersion(version: AntigravityVersion): boolean {
  return compareVersion(version.shortVersion, '1.16.5') >= 0;
}
