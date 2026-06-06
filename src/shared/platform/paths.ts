import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import findProcess, { type ProcessInfo } from 'find-process';
import type { AntigravityAppTarget } from '@/modules/account/types';
import { resolveAntigravityAppTarget } from '@/modules/account/types';

/**
 * Checks if the current platform is WSL.
 * @returns {boolean} True if the current platform is WSL, false otherwise.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return version.includes('microsoft') && version.includes('wsl');
  } catch {
    return false;
  }
}

let cachedWindowsUser: string | null = null;

/**
 * Gets the Windows username.
 * @returns {string} The Windows username.
 */
function getWindowsUser(): string {
  if (cachedWindowsUser) return cachedWindowsUser;

  // Strategy 1: Try cmd.exe to get actual Windows username (most reliable for WSL)
  try {
    // We use execSync because this function needs to be synchronous
    // and it's usually called once or cached.
    const stdout = execSync('/mnt/c/Windows/System32/cmd.exe /c "echo %USERNAME%"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Output might contain warnings about UNC paths, so we take the last line
    const lines = stdout.trim().split(/\r?\n/);
    const user = lines[lines.length - 1].trim();

    if (user) {
      cachedWindowsUser = user;
      return user;
    }
  } catch {
    // Ignore errors
  }

  // Strategy 2: Try to match current Linux username
  const linuxUser = os.userInfo().username;
  if (fs.existsSync(`/mnt/c/Users/${linuxUser}`)) {
    cachedWindowsUser = linuxUser;
    return linuxUser;
  }

  // Strategy 3: List users and pick first likely candidate
  try {
    const users = fs
      .readdirSync('/mnt/c/Users')
      .filter(
        (u) =>
          !['Public', 'Default', 'Default User', 'All Users', 'desktop.ini'].includes(u) &&
          fs.statSync(path.join('/mnt/c/Users', u)).isDirectory(),
      );
    if (users.length > 0) {
      cachedWindowsUser = users[0];
      return users[0];
    }
  } catch {
    // Ignore errors when reading directory
  }

  return 'User'; // Fallback
}

function getAntigravityAppFolderName(target?: AntigravityAppTarget | null): string {
  return resolveAntigravityAppTarget(target) === 'ide' ? 'Antigravity IDE' : 'Antigravity';
}

function appendUniquePath(paths: string[], targetPath: string | null | undefined): void {
  if (!targetPath || paths.includes(targetPath)) {
    return;
  }

  paths.push(targetPath);
}

function normalizeExecutablePath(executablePath: string): string {
  let pathForComparison = executablePath;
  try {
    if (fs.existsSync(executablePath)) {
      pathForComparison = fs.realpathSync.native(executablePath);
    }
  } catch {
    pathForComparison = executablePath;
  }

  const normalizedPath = path.normalize(pathForComparison).toLowerCase();
  if (process.platform === 'win32') {
    return normalizedPath.replace(/\//g, '\\');
  }

  return normalizedPath;
}

function areExecutablePathsEquivalent(
  leftExecutablePath: string,
  rightExecutablePath: string,
): boolean {
  const leftNormalized = normalizeExecutablePath(leftExecutablePath);
  const rightNormalized = normalizeExecutablePath(rightExecutablePath);

  if (process.platform === 'darwin') {
    const leftAppIndex = leftNormalized.indexOf('.app');
    const rightAppIndex = rightNormalized.indexOf('.app');
    if (leftAppIndex >= 0 && rightAppIndex >= 0) {
      return (
        leftNormalized.slice(0, leftAppIndex + 4) === rightNormalized.slice(0, rightAppIndex + 4)
      );
    }
  }

  return leftNormalized === rightNormalized;
}

function hasAntigravityIdeMarker(value: string): boolean {
  const normalizedValue = value.toLowerCase();
  return normalizedValue.includes('antigravity ide') || normalizedValue.includes('antigravity-ide');
}

const ANTIGRAVITY_HELPER_PROCESS_NAME_PATTERNS = [
  'helper',
  'plugin',
  'renderer',
  'gpu',
  'crashpad',
  'utility',
  'audio',
  'sandbox',
  'language_server',
];

function isAntigravityHelperProcess(processName: string, commandLine: string): boolean {
  const normalizedProcessName = processName.toLowerCase();
  const normalizedCommandLine = commandLine.toLowerCase();

  if (normalizedCommandLine.includes('--type=') || normalizedCommandLine.includes('crashpad')) {
    return true;
  }

  return ANTIGRAVITY_HELPER_PROCESS_NAME_PATTERNS.some((pattern) =>
    normalizedProcessName.includes(pattern),
  );
}

export interface AntigravityProcessCandidate {
  name: string;
  commandLine: string;
  executablePath?: string;
}

export function isTargetAntigravityProcessCandidate(
  processItem: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const nameLower = processItem.name.toLowerCase();
  const cmdLower = processItem.commandLine.toLowerCase();
  const configuredClassicPath = getConfiguredAntigravityExecutablePath('classic', false);
  const configuredIdePath = getConfiguredAntigravityExecutablePath('ide', false);
  const strictConfiguredClassicPath = getConfiguredAntigravityExecutablePath('classic', true);
  const strictConfiguredIdePath = getConfiguredAntigravityExecutablePath('ide', true);
  const commandExecutablePath = parseCommandLineArguments(processItem.commandLine)[0] || '';
  const executableIdentity = `${processItem.executablePath || ''} ${commandExecutablePath}`;
  const hasAntigravityProcessIdentity =
    nameLower.includes('antigravity') || executableIdentity.toLowerCase().includes('antigravity');
  const matchesClassicPath =
    Boolean((configuredClassicPath && processItem.executablePath) || '') &&
    areExecutablePathsEquivalent(configuredClassicPath as string, processItem.executablePath || '');
  const matchesIdePath =
    Boolean((configuredIdePath && processItem.executablePath) || '') &&
    areExecutablePathsEquivalent(configuredIdePath as string, processItem.executablePath || '');
  const isIde =
    hasAntigravityIdeMarker(nameLower) ||
    hasAntigravityIdeMarker(executableIdentity) ||
    (hasAntigravityProcessIdentity && hasAntigravityIdeMarker(cmdLower)) ||
    matchesIdePath;

  if (isAntigravityHelperProcess(nameLower, cmdLower)) {
    return false;
  }

  if (normalizedTarget === 'ide') {
    if (matchesClassicPath) {
      return false;
    }
    if (strictConfiguredIdePath) {
      return matchesIdePath;
    }
    return isIde;
  }

  if (matchesIdePath) {
    return false;
  }
  if (strictConfiguredClassicPath) {
    return matchesClassicPath;
  }

  return (
    (nameLower.includes('antigravity') || cmdLower.includes('antigravity')) &&
    !isIde &&
    !nameLower.includes('manager') &&
    !cmdLower.includes('manager') &&
    !nameLower.includes('tools') &&
    !cmdLower.includes('tools')
  );
}

export function isConfiguredTargetExecutableProcessCandidate(
  processItem: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const executablePath = processItem.executablePath || '';
  if (!executablePath) {
    return false;
  }

  const configuredClassicPath = getConfiguredAntigravityExecutablePath('classic', true);
  const configuredIdePath = getConfiguredAntigravityExecutablePath('ide', true);
  const matchesClassicPath =
    Boolean(configuredClassicPath) &&
    areExecutablePathsEquivalent(configuredClassicPath as string, executablePath);
  const matchesIdePath =
    Boolean(configuredIdePath) &&
    areExecutablePathsEquivalent(configuredIdePath as string, executablePath);

  if (normalizedTarget === 'ide') {
    return matchesIdePath && !matchesClassicPath;
  }

  return matchesClassicPath && !matchesIdePath;
}

export function isTargetAntigravityExecutableProcessCandidate(
  processItem: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const oppositeTarget: AntigravityAppTarget = normalizedTarget === 'ide' ? 'classic' : 'ide';
  const executablePath =
    processItem.executablePath ||
    resolveExecutablePathFromProcessInfo(null, processItem.commandLine);

  if (!executablePath) {
    return false;
  }

  const targetExecutablePath = getAntigravityExecutablePath(normalizedTarget);
  if (!targetExecutablePath) {
    return false;
  }

  if (!areExecutablePathsEquivalent(targetExecutablePath, executablePath)) {
    return false;
  }

  const oppositeExecutablePath = getAntigravityExecutablePath(oppositeTarget);
  return !(
    oppositeExecutablePath && areExecutablePathsEquivalent(oppositeExecutablePath, executablePath)
  );
}

function parseCommandLineArguments(commandLine: string): string[] {
  const commandLineArguments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    const previous = index > 0 ? commandLine[index - 1] : '';

    if ((char === '"' || char === "'") && previous !== '\\') {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      } else {
        current += char;
      }
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        commandLineArguments.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    commandLineArguments.push(current);
  }

  return commandLineArguments;
}

function extractUserDataDirectoryFromArgs(commandLineArguments: string[]): string | null {
  for (let index = 0; index < commandLineArguments.length; index += 1) {
    const argument = commandLineArguments[index];

    if (argument === '--user-data-dir' && commandLineArguments[index + 1]) {
      return path.resolve(commandLineArguments[index + 1]);
    }

    if (argument.startsWith('--user-data-dir=')) {
      const userDataDir = argument.slice('--user-data-dir='.length);
      if (userDataDir) {
        return path.resolve(userDataDir);
      }
    }
  }

  return null;
}

function resolveExecutablePathFromProcessInfo(
  executablePath: string | null | undefined,
  commandLine: string,
): string {
  if (executablePath) {
    return executablePath;
  }

  const executableCandidate = parseCommandLineArguments(commandLine)[0];
  if (!executableCandidate) {
    return '';
  }

  return executableCandidate;
}

function readAntigravityManagerConfig(): {
  antigravity_executable?: unknown;
  antigravity_ide_executable?: unknown;
  antigravity_args?: unknown;
  antigravity_ide_args?: unknown;
} | null {
  const configPaths = [
    path.join(getAgentDir(), CONFIG_FILENAME),
    path.join(getAppDataDir(), CONFIG_FILENAME),
  ];

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }

      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        antigravity_executable?: unknown;
        antigravity_ide_executable?: unknown;
        antigravity_args?: unknown;
        antigravity_ide_args?: unknown;
      };
    } catch {
      continue;
    }
  }

  return null;
}

interface RunningAntigravityProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

const PROCESS_SCAN_TIMEOUT_MS = 2500;
const PROCESS_SCAN_CACHE_MS = 60000;
const CONFIG_FILENAME = 'gui_config.json';
let runningProcessCache: {
  platform: NodeJS.Platform;
  target: AntigravityAppTarget;
  checkedAt: number;
  processes: RunningAntigravityProcess[];
} | null = null;

function processInfoToRunningProcess(processInfo: ProcessInfo): RunningAntigravityProcess {
  const commandLine = processInfo.cmd || processInfo.name || '';
  return {
    pid: processInfo.pid,
    name: processInfo.name || '',
    executablePath: resolveExecutablePathFromProcessInfo(processInfo.bin, commandLine),
    commandLine,
  };
}

function getProcessSearchNames(target?: AntigravityAppTarget | null): string[] {
  const searchNames =
    resolveAntigravityAppTarget(target) === 'ide'
      ? ['Antigravity IDE', 'antigravity-ide', 'Antigravity', 'antigravity']
      : ['Antigravity', 'antigravity'];

  searchNames.push('');

  return searchNames;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('process_scan_timeout'));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export async function refreshAntigravityProcessCache(
  target?: AntigravityAppTarget | null,
): Promise<void> {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const processMap = new Map<number, RunningAntigravityProcess>();

  for (const searchName of getProcessSearchNames(target)) {
    try {
      const matches = await withTimeout(
        findProcess('name', searchName, {
          strict: false,
          logLevel: 'error',
        }),
        PROCESS_SCAN_TIMEOUT_MS,
      );

      for (const processInfo of matches) {
        const runningProcess = processInfoToRunningProcess(processInfo);
        if (runningProcess.pid > 0 && isTargetAntigravityProcessCandidate(runningProcess, target)) {
          processMap.set(runningProcess.pid, runningProcess);
        }
      }
    } catch {
      // Process discovery is opportunistic. Standard and portable path fallbacks still apply.
    }
  }

  runningProcessCache = {
    platform: process.platform,
    target: resolvedTarget,
    checkedAt: Date.now(),
    processes: Array.from(processMap.values()),
  };
}

function getRunningAntigravityProcesses(
  target?: AntigravityAppTarget | null,
): RunningAntigravityProcess[] {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const now = Date.now();

  if (
    runningProcessCache &&
    runningProcessCache.platform === process.platform &&
    runningProcessCache.target === resolvedTarget &&
    now - runningProcessCache.checkedAt < PROCESS_SCAN_CACHE_MS
  ) {
    return runningProcessCache.processes;
  }

  return [];
}

function getUserDataDirFromRunningProcess(target?: AntigravityAppTarget | null): string | null {
  const configuredUserDataDir = extractUserDataDirectoryFromArgs(
    getConfiguredAntigravityArgs(target),
  );
  if (configuredUserDataDir && fs.existsSync(configuredUserDataDir)) {
    return configuredUserDataDir;
  }

  for (const commandLineArguments of getAntigravityArgsFromRunningProcess(target)) {
    const userDataDir = extractUserDataDirectoryFromArgs(commandLineArguments);
    if (userDataDir && fs.existsSync(userDataDir)) {
      return userDataDir;
    }
  }

  return null;
}

function getExecutablePathFromRunningProcess(target?: AntigravityAppTarget | null): string | null {
  for (const processItem of getRunningAntigravityProcesses(target)) {
    if (processItem.executablePath && fs.existsSync(processItem.executablePath)) {
      return processItem.executablePath;
    }
  }

  return null;
}

export function getAntigravityArgsFromRunningProcess(
  target?: AntigravityAppTarget | null,
): string[][] {
  return getRunningAntigravityProcesses(target)
    .map((processItem) => parseCommandLineArguments(processItem.commandLine))
    .filter((commandLineArguments) => commandLineArguments.length > 0);
}

export function getAntigravityLaunchArgsFromRunningProcess(
  target?: AntigravityAppTarget | null,
): string[] {
  return getAntigravityArgsFromRunningProcess(target)[0]?.slice(1) || [];
}

export function getConfiguredAntigravityArgs(target?: AntigravityAppTarget | null): string[] {
  const rawConfig = readAntigravityManagerConfig();
  const configKey =
    resolveAntigravityAppTarget(target) === 'ide' ? 'antigravity_ide_args' : 'antigravity_args';
  const configuredArgs = rawConfig?.[configKey];

  if (!Array.isArray(configuredArgs)) {
    return [];
  }

  return configuredArgs.filter((arg): arg is string => typeof arg === 'string');
}

function getConfiguredAntigravityExecutablePath(
  target?: AntigravityAppTarget | null,
  requireExists = true,
): string | null {
  const rawConfig = readAntigravityManagerConfig();
  const configKey =
    resolveAntigravityAppTarget(target) === 'ide'
      ? 'antigravity_ide_executable'
      : 'antigravity_executable';
  const configuredPath = rawConfig?.[configKey];

  if (typeof configuredPath !== 'string') {
    return null;
  }

  const executablePath = configuredPath.trim();
  if (!executablePath) {
    return null;
  }
  if (requireExists && !fs.existsSync(executablePath)) {
    return null;
  }

  return executablePath;
}

function pushUserDataDbPaths(paths: string[], userDataDir: string): void {
  appendUniquePath(paths, path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'));
  appendUniquePath(paths, path.join(userDataDir, 'User', 'state.vscdb'));
  appendUniquePath(paths, path.join(userDataDir, 'state.vscdb'));
}

function pushUserDataStoragePaths(paths: string[], userDataDir: string): void {
  appendUniquePath(paths, path.join(userDataDir, 'User', 'globalStorage', 'storage.json'));
  appendUniquePath(paths, path.join(userDataDir, 'User', 'storage.json'));
  appendUniquePath(paths, path.join(userDataDir, 'storage.json'));
}

function getPortableUserDataDir(target?: AntigravityAppTarget | null): string | null {
  const executablePath = getAntigravityExecutablePath(target);
  if (!executablePath) {
    return null;
  }

  return path.join(path.dirname(executablePath), 'data', 'user-data');
}

export function getAppDataDir(target?: AntigravityAppTarget | null): string {
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);

  if (isWsl()) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Roaming/${folderName}`;
  }

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', folderName);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), folderName);
    case 'linux':
      return path.join(home, '.config', folderName);
    default:
      return path.join(home, '.antigravity');
  }
}

export function getAgentDir(): string {
  return path.join(os.homedir(), '.antigravity-agent');
}

export function getAccountsFilePath(): string {
  return path.join(getAgentDir(), 'antigravity_accounts.json');
}

export function getBackupsDir(): string {
  return path.join(getAgentDir(), 'backups');
}

export function getCloudAccountsDbPath(): string {
  return path.join(getAgentDir(), 'cloud_accounts.db');
}

export function getAntigravityDbPaths(target?: AntigravityAppTarget | null): string[] {
  const appData = getAppDataDir(target);
  const paths: string[] = [];
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);
  const userDataDir = getUserDataDirFromRunningProcess(target);
  const portableUserDataDir = getPortableUserDataDir(target);

  if (userDataDir) {
    pushUserDataDbPaths(paths, userDataDir);
  }

  if (portableUserDataDir) {
    pushUserDataDbPaths(paths, portableUserDataDir);
  }

  if (isWsl()) {
    // Assume standard structure: AppData/Roaming/Antigravity/User/globalStorage/state.vscdb
    // appData is already resolved to Roaming/Antigravity in getAppDataDir()
    pushUserDataDbPaths(paths, appData);
    return paths;
  }

  if (process.platform === 'linux') {
    pushUserDataDbPaths(paths, appData);
    return paths;
  }

  if (process.platform === 'darwin') {
    // Standard path
    appendUniquePath(
      paths,
      path.join(
        home,
        'Library',
        'Application Support',
        folderName,
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    );
    // Fallback path
    appendUniquePath(
      paths,
      path.join(home, 'Library', 'Application Support', folderName, 'state.vscdb'),
    );
    return paths;
  }

  // Windows
  // Standard path
  appendUniquePath(paths, path.join(appData, 'User', 'globalStorage', 'state.vscdb'));
  // Fallback paths
  appendUniquePath(paths, path.join(appData, 'User', 'state.vscdb'));
  appendUniquePath(paths, path.join(appData, 'state.vscdb'));

  return paths;
}

export function getAntigravityStoragePaths(target?: AntigravityAppTarget | null): string[] {
  const appData = getAppDataDir(target);
  const paths: string[] = [];
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);
  const userDataDir = getUserDataDirFromRunningProcess(target);
  const portableUserDataDir = getPortableUserDataDir(target);

  if (userDataDir) {
    pushUserDataStoragePaths(paths, userDataDir);
  }

  if (portableUserDataDir) {
    pushUserDataStoragePaths(paths, portableUserDataDir);
  }

  if (isWsl()) {
    pushUserDataStoragePaths(paths, appData);
    return paths;
  }

  if (process.platform === 'linux') {
    pushUserDataStoragePaths(paths, appData);
    return paths;
  }

  if (process.platform === 'darwin') {
    appendUniquePath(
      paths,
      path.join(
        home,
        'Library',
        'Application Support',
        folderName,
        'User',
        'globalStorage',
        'storage.json',
      ),
    );
    appendUniquePath(
      paths,
      path.join(home, 'Library', 'Application Support', folderName, 'storage.json'),
    );
    return paths;
  }

  appendUniquePath(paths, path.join(appData, 'User', 'globalStorage', 'storage.json'));
  appendUniquePath(paths, path.join(appData, 'User', 'storage.json'));
  appendUniquePath(paths, path.join(appData, 'storage.json'));
  return paths;
}

export function getAntigravityStoragePath(target?: AntigravityAppTarget | null): string {
  const paths = getAntigravityStoragePaths(target);
  return paths.length > 0 ? paths[0] : '';
}

// Keep for backward compatibility if needed, but prefer getAntigravityDbPaths
export function getAntigravityDbPath(target?: AntigravityAppTarget | null): string {
  const paths = getAntigravityDbPaths(target);
  return paths.length > 0 ? paths[0] : '';
}

export function getAntigravityExecutablePath(target?: AntigravityAppTarget | null): string {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const executableName = getAntigravityAppFolderName(target);
  const runningExecutablePath = getExecutablePathFromRunningProcess(target);

  if (runningExecutablePath) {
    return runningExecutablePath;
  }

  const configuredExecutablePath = getConfiguredAntigravityExecutablePath(resolvedTarget);
  if (configuredExecutablePath) {
    return configuredExecutablePath;
  }

  if (isWsl()) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Local/Programs/${executableName}/${executableName}.exe`;
  }

  switch (process.platform) {
    case 'darwin':
      return `/Applications/${executableName}.app/Contents/MacOS/${executableName}`;
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || '';
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

      const possiblePaths = [
        path.join(localAppData, 'Programs', executableName, `${executableName}.exe`),
        path.join(programFiles, executableName, `${executableName}.exe`),
        path.join(programFilesX86, executableName, `${executableName}.exe`),
      ];

      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          return possiblePath;
        }
      }

      // No known path found; return empty string (caller must handle missing binary)
      return '';
    }
    case 'linux': {
      const possibleLinuxPaths =
        resolvedTarget === 'ide'
          ? [
              '/usr/bin/antigravity-ide',
              '/usr/local/bin/antigravity-ide',
              '/opt/Antigravity IDE/antigravity-ide',
              '/opt/antigravity-ide/antigravity-ide',
              path.join(os.homedir(), '.local', 'share', 'antigravity-ide', 'antigravity-ide'),
            ]
          : [
              '/usr/bin/antigravity',
              '/usr/local/bin/antigravity',
              '/usr/share/antigravity/antigravity',
              '/opt/Antigravity/antigravity',
              '/opt/antigravity/antigravity',
              path.join(os.homedir(), '.local', 'share', 'antigravity', 'antigravity'),
            ];

      for (const possiblePath of possibleLinuxPaths) {
        if (fs.existsSync(possiblePath)) {
          return possiblePath;
        }
      }

      // Fallback: try `which antigravity` via path lookup
      const binaryName = resolvedTarget === 'ide' ? 'antigravity-ide' : 'antigravity';
      const fromPath = process.env.PATH?.split(':')
        .map((dir) => path.join(dir, binaryName))
        .find((p) => fs.existsSync(p));
      if (fromPath) {
        return fromPath;
      }

      // No known path found; return empty string (caller must handle missing binary)
      return '';
    }
    default:
      return '';
  }
}
