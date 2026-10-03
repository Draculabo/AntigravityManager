import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';

const AGY_CLI_DIR_SEGMENTS = ['.gemini', 'antigravity-cli'] as const;
const AGY_CLI_TOKEN_FILE = 'antigravity-oauth-token';
const WSL_DISTRO_CACHE_TTL_MS = 60_000;
const AGY_CLI_WSL_HOME_EXECUTABLE_SEGMENTS = ['.local', 'bin', 'agy'] as const;
const AGY_CLI_WSL_SYSTEM_EXECUTABLE_SEGMENTS: readonly (readonly string[])[] = [
  ['usr', 'local', 'bin', 'agy'],
  ['usr', 'bin', 'agy'],
];

let cachedRunningWslDistros: { names: string[]; readAt: number } | null = null;

export interface GetAgyCliTokenPathsOptions {
  exists?: (candidatePath: string) => boolean;
  homeDirectory?: string;
  listRunningWslDistros?: () => string[];
  pathEnvironment?: string;
  platform?: NodeJS.Platform;
  resolveWslHomeForDistro?: (distro: string) => string | null;
}

/**
 * Returns token files for CLI sessions owned by the current local user.
 *
 * On Windows, only the default user of each already-running WSL distribution is
 * considered. A system-wide `agy` install must never make another WSL user's
 * session eligible for the current Windows account's OAuth payload.
 */
export function getAgyCliTokenPaths(options: GetAgyCliTokenPathsOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const localPathApi = platform === 'win32' ? path.win32 : path.posix;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const exists = options.exists ?? fs.existsSync;
  const listRunningWslDistros =
    options.listRunningWslDistros ?? (() => getRunningWslDistros(platform));
  const resolveWslHomeForDistro = options.resolveWslHomeForDistro ?? resolveDefaultWslHomeDirectory;
  const tokenPaths: string[] = [];

  const localExecutablePath = detectAgyCliExecutablePath({
    exists,
    homeDirectory,
    pathEnvironment: options.pathEnvironment ?? process.env.PATH,
    platform,
  });
  if (localExecutablePath) {
    const sessionDirectory = localPathApi.join(homeDirectory, ...AGY_CLI_DIR_SEGMENTS);
    if (exists(sessionDirectory)) {
      appendUniquePath(tokenPaths, localPathApi.join(sessionDirectory, AGY_CLI_TOKEN_FILE));
    }
  }

  if (platform !== 'win32') {
    return tokenPaths;
  }

  for (const distro of listRunningWslDistros()) {
    const linuxHome = resolveWslHomeForDistro(distro);
    const distroRoot = `\\\\wsl.localhost\\${distro}`;
    const wslHome = linuxHome ? toWslUncPath(distroRoot, linuxHome) : null;
    if (!wslHome || !hasWslAgyCliExecutable(exists, distroRoot, wslHome)) {
      continue;
    }

    const sessionDirectory = path.win32.join(wslHome, ...AGY_CLI_DIR_SEGMENTS);
    if (exists(sessionDirectory)) {
      appendUniquePath(tokenPaths, path.win32.join(sessionDirectory, AGY_CLI_TOKEN_FILE));
    }
  }

  return tokenPaths;
}

function getRunningWslDistros(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return [];
  }

  const now = Date.now();
  if (cachedRunningWslDistros && now - cachedRunningWslDistros.readAt < WSL_DISTRO_CACHE_TTL_MS) {
    return cachedRunningWslDistros.names;
  }

  let names: string[] = [];
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q', '--running'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf-8');
    names = text
      .split(/\r?\n/u)
      .map((line) => line.replaceAll('\0', '').trim())
      .filter(Boolean);
  } catch {
    names = [];
  }

  cachedRunningWslDistros = { names, readAt: now };
  return names;
}

function resolveDefaultWslHomeDirectory(distro: string): string | null {
  try {
    const home = execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-lc', 'printf %s "$HOME"'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return home || null;
  } catch {
    return null;
  }
}

function toWslUncPath(distroRoot: string, linuxPath: string): string | null {
  const normalizedPath = path.posix.normalize(linuxPath.trim());
  if (!path.posix.isAbsolute(normalizedPath) || normalizedPath === '/') {
    return null;
  }

  return path.win32.join(distroRoot, normalizedPath.slice(1).replaceAll('/', '\\'));
}

function hasWslAgyCliExecutable(
  exists: (candidatePath: string) => boolean,
  distroRoot: string,
  homeDirectory: string,
): boolean {
  if (exists(path.win32.join(homeDirectory, ...AGY_CLI_WSL_HOME_EXECUTABLE_SEGMENTS))) {
    return true;
  }

  return AGY_CLI_WSL_SYSTEM_EXECUTABLE_SEGMENTS.some((segments) =>
    exists(path.win32.join(distroRoot, ...segments)),
  );
}

function appendUniquePath(paths: string[], targetPath: string): void {
  if (!paths.includes(targetPath)) {
    paths.push(targetPath);
  }
}
