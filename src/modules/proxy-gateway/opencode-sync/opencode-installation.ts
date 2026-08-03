import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { compact, uniq } from 'lodash-es';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface OpenCodeInstallationStatus {
  installed: boolean;
  version: string | null;
}

export type OpenCodeInstallationDetector = () => Promise<OpenCodeInstallationStatus>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function extractOpenCodeVersion(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return 'unknown';
  }

  for (const part of trimmed.split(/\s+/)) {
    const candidate = part.includes('/') ? part.slice(part.indexOf('/') + 1) : part;
    if (/^\d[\d.]*\.\d+$/.test(candidate)) {
      return candidate;
    }
  }

  const fallback = trimmed.match(/\d[\d.]*/)?.[0] ?? '';
  return fallback.includes('.') ? fallback : 'unknown';
}

async function scanChildDirectories(
  directory: string,
  relativeExecutablePaths: readonly string[][],
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        relativeExecutablePaths.map((segments) => join(directory, entry.name, ...segments)),
      );
  } catch {
    return [];
  }
}

async function getFallbackCandidates(
  homeDirectory: string,
  currentPlatform: NodeJS.Platform,
): Promise<string[]> {
  if (currentPlatform === 'win32') {
    const nvmDirectories = uniq(compact([process.env.NVM_HOME, join(homeDirectory, '.nvm')]));
    const nvmCandidates = (
      await Promise.all(
        nvmDirectories.map((directory) =>
          scanChildDirectories(directory, [['opencode.cmd'], ['opencode.exe']]),
        ),
      )
    ).flat();
    return compact([
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'opencode.cmd') : null,
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'opencode.exe') : null,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'opencode.cmd') : null,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm', 'opencode.exe') : null,
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Yarn', 'bin', 'opencode.cmd')
        : null,
      ...nvmCandidates,
    ]);
  }

  const nvmCandidates = await scanChildDirectories(
    join(homeDirectory, '.nvm', 'versions', 'node'),
    [['bin', 'opencode']],
  );
  const fnmDirectories = [
    join(homeDirectory, '.fnm', 'node-versions'),
    join(homeDirectory, 'Library', 'Application Support', 'fnm', 'node-versions'),
  ];
  const fnmCandidates = (
    await Promise.all(
      fnmDirectories.map((directory) =>
        scanChildDirectories(directory, [['installation', 'bin', 'opencode']]),
      ),
    )
  ).flat();
  return [
    join(homeDirectory, '.local', 'bin', 'opencode'),
    join(homeDirectory, '.npm-global', 'bin', 'opencode'),
    join(homeDirectory, '.volta', 'bin', 'opencode'),
    join(homeDirectory, 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    ...nvmCandidates,
    ...fnmCandidates,
  ];
}

async function findPathCandidates(currentPlatform: NodeJS.Platform): Promise<string[]> {
  const executable = currentPlatform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(executable, ['opencode'], {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function runVersionCommand(
  executablePath: string,
  currentPlatform: NodeJS.Platform,
): Promise<string | null> {
  try {
    const isWindowsScript =
      currentPlatform === 'win32' &&
      ['.bat', '.cmd'].includes(extname(executablePath).toLowerCase());
    const command = isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : executablePath;
    const args = isWindowsScript ? ['/d', '/s', '/c', executablePath, '--version'] : ['--version'];
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return extractOpenCodeVersion(stdout.trim() ? stdout : stderr);
  } catch {
    return null;
  }
}

export async function detectOpenCodeInstallation(): Promise<OpenCodeInstallationStatus> {
  const currentPlatform = platform();
  const pathCandidates = await findPathCandidates(currentPlatform);
  const fallbackCandidates = await getFallbackCandidates(homedir(), currentPlatform);
  const environmentCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      currentPlatform === 'win32'
        ? [
            join(directory, 'opencode.exe'),
            join(directory, 'opencode.cmd'),
            join(directory, 'opencode.bat'),
          ]
        : [join(directory, 'opencode')],
    );
  const candidates = uniq([...pathCandidates, ...environmentCandidates, ...fallbackCandidates]);

  const existingCandidates = (
    await Promise.all(
      candidates.map(async (candidate) => ((await pathExists(candidate)) ? candidate : null)),
    )
  ).filter((candidate): candidate is string => candidate !== null);

  for (const candidate of existingCandidates) {
    const version = await runVersionCommand(candidate, currentPlatform);
    if (version) {
      return { installed: true, version };
    }
  }

  return { installed: false, version: null };
}
