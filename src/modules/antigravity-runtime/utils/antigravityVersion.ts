import fs from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWindowsFileVersion } from './windowsFileVersion';
import { compare, coerce, parse } from 'semver';
import { z } from 'zod';
import { getAntigravityExecutablePath } from '@/shared/platform/paths';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { resolveAntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';

export interface AntigravityVersion {
  shortVersion: string;
  bundleVersion: string;
}

const cachedVersions = new Map<string, AntigravityVersion>();
const pendingVersions = new Map<string, Promise<AntigravityVersion>>();
const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 2500;
const PackageJsonVersionSchema = z.object({
  name: z.string().regex(/antigravity/i),
  version: z.string().trim().min(1),
});

function cacheAndReturn(cacheKey: string, version: AntigravityVersion): AntigravityVersion {
  cachedVersions.set(cacheKey, version);
  return version;
}

function readPackageJsonVersion(execPath: string): AntigravityVersion | null {
  const parentDir = path.dirname(execPath);
  const candidates = [
    path.join(parentDir, 'resources', 'app', 'package.json'),
    path.join(parentDir, 'resources', 'app.asar', 'package.json'),
  ];

  for (const packageJson of candidates) {
    if (!fs.existsSync(packageJson)) {
      continue;
    }
    try {
      const content = fs.readFileSync(packageJson, 'utf-8');
      const rawManifest: unknown = JSON.parse(content);
      const manifest = PackageJsonVersionSchema.safeParse(rawManifest);
      if (!manifest.success) {
        continue;
      }
      const parsed = parseVersionString(manifest.data.version);
      if (!parse(parsed) && !coerce(parsed)) {
        continue;
      }
      return {
        shortVersion: parsed,
        bundleVersion: parsed,
      };
    } catch {
      continue;
    }
  }

  return null;
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

async function readVersion(execPath: string): Promise<AntigravityVersion> {
  if (process.platform === 'win32') {
    const parsed = parseVersionString(await readWindowsFileVersion(execPath));
    return { shortVersion: parsed, bundleVersion: parsed };
  }
  if (process.platform === 'darwin') {
    const plistPath = getPlistPath(execPath);
    let content = fs.readFileSync(plistPath, 'utf-8');
    if (content.startsWith('bplist')) {
      const output = await execFileAsync('plutil', ['-convert', 'xml1', '-o', '-', plistPath], {
        encoding: 'utf-8',
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      content = output.stdout;
    }
    const shortVersion = parseVersionString(readPlistValue(content, 'CFBundleShortVersionString'));
    return {
      shortVersion,
      bundleVersion: parseVersionString(readPlistValue(content, 'CFBundleVersion') || shortVersion),
    };
  }
  if (process.platform === 'linux') {
    // --version can launch an Electron GUI, including across WSL interop.
    // Missing installation metadata must never start an application.
    const manifest = readPackageJsonVersion(execPath);
    if (manifest) {
      return manifest;
    }
    throw new Error('Unable to read Antigravity product version from its installation');
  }
  throw new Error('Unable to determine Antigravity version');
}

function getPlistPath(execPath: string): string {
  const appIndex = execPath.toLowerCase().indexOf('.app');
  const appPath = appIndex >= 0 ? execPath.slice(0, appIndex + 4) : execPath;
  return path.join(appPath, 'Contents', 'Info.plist');
}

function getVersionCacheKey(target: AntigravityAppTarget, execPath: string): string {
  const parent = path.dirname(execPath);
  const files = [
    execPath,
    path.join(parent, 'resources', 'app', 'package.json'),
    path.join(parent, 'resources', 'app.asar', 'package.json'),
  ];
  if (process.platform === 'darwin') {
    files.push(getPlistPath(execPath));
  }
  const identities = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    } catch {
      return file + ':missing';
    }
  });
  return [target, ...identities].join('|');
}

/** Coalesces probes; failed queries remain retryable after installation repair. */
export function getCachedAntigravityVersion(
  target?: AntigravityAppTarget | null,
): AntigravityVersion | undefined {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const execPath = getAntigravityExecutablePath(resolvedTarget);
  return execPath ? cachedVersions.get(getVersionCacheKey(resolvedTarget, execPath)) : undefined;
}

export async function getAntigravityVersion(
  target?: AntigravityAppTarget | null,
  executablePath?: string,
): Promise<AntigravityVersion> {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const execPath = executablePath ?? getAntigravityExecutablePath(resolvedTarget);
  if (!execPath) {
    throw new Error('Unable to locate Antigravity executable');
  }
  const cacheKey = getVersionCacheKey(resolvedTarget, execPath);
  const cachedVersion = cachedVersions.get(cacheKey);
  if (cachedVersion) {
    return cachedVersion;
  }
  let pending = pendingVersions.get(cacheKey);
  if (!pending) {
    pending = readVersion(execPath).then((version) => cacheAndReturn(cacheKey, version));
    pendingVersions.set(cacheKey, pending);
    const release = () => {
      pendingVersions.delete(cacheKey);
    };
    pending.then(release, release);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Antigravity version query timed out')),
          VERSION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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

export function isCredentialStoreVersion(version: AntigravityVersion): boolean {
  return compareVersion(version.shortVersion, '2.0.0') >= 0;
}
