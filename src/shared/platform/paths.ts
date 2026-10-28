import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { readNativeProcessSnapshot } from './nativeProcessQuery';
import {
  getAntigravityExecutableTarget,
  isAntigravityWindowsInstaller,
  isAntigravityHelperProcess,
} from './antigravityProcessIdentity';
import { findWindowsClientExecutables } from './windowsClientExecutable';
import { z } from 'zod';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { resolveAntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';

type PathApi = Pick<
  typeof path,
  'dirname' | 'join' | 'normalize' | 'resolve' | 'basename' | 'relative' | 'isAbsolute'
>;

const AntigravityManagerConfigSchema = z.object({
  antigravity_executable: z.string().nullable().optional(),
  antigravity_ide_executable: z.string().nullable().optional(),
  antigravity_args: z.array(z.string()).optional(),
  antigravity_ide_args: z.array(z.string()).optional(),
});

type AntigravityManagerConfig = z.infer<typeof AntigravityManagerConfigSchema>;

export interface PathResolutionOptions {
  platform?: NodeJS.Platform;
  isWsl?: boolean;
  /** Explicit operation snapshot; suppresses cache and default-directory fallbacks. */
  userDataDir?: string;
  executablePath?: string;
  ignoreRunningProcessCache?: boolean;
  /** Observe competing named installations before applying configured-path policy. */
  ignoreExecutableConfiguration?: boolean;
}

function getCurrentPlatform(options?: PathResolutionOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

function getCurrentPlatformPathApi(options?: PathResolutionOptions): PathApi {
  return getCurrentPlatform(options) === 'win32' ? path.win32 : path.posix;
}

/**
 * Checks if the current platform is WSL.
 * @param {NodeJS.Platform} [platform] The platform to check, defaults to `process.platform`.
 * @returns {boolean} True if the current platform is WSL, false otherwise.
 */
export function isWsl(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return version.includes('microsoft') && version.includes('wsl');
  } catch {
    return false;
  }
}

function resolveIsWsl(options?: PathResolutionOptions): boolean {
  return options?.isWsl ?? isWsl(getCurrentPlatform(options));
}

let cachedWindowsUser: string | null = null;

/**
 * Gets the Windows username.
 * @returns {string} The Windows username.
 */
function getWindowsUser(): string {
  if (cachedWindowsUser) {
    return cachedWindowsUser;
  }

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
          fs.statSync(path.posix.join('/mnt/c/Users', u)).isDirectory(),
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

function normalizeExecutablePath(executablePath: string, options?: PathResolutionOptions): string {
  let pathForComparison = executablePath;
  try {
    if (fs.existsSync(executablePath)) {
      pathForComparison = fs.realpathSync.native(executablePath);
    }
  } catch {
    pathForComparison = executablePath;
  }

  const pathApi = getCurrentPlatformPathApi(options);
  const normalizedPath = pathApi.normalize(pathForComparison);

  if (getCurrentPlatform(options) === 'win32') {
    return normalizedPath.toLowerCase().replace(/\//g, '\\');
  }

  return getCurrentPlatform(options) === 'linux' ? normalizedPath : normalizedPath.toLowerCase();
}

export function areExecutablePathsEquivalent(
  leftExecutablePath: string,
  rightExecutablePath: string,
  options?: PathResolutionOptions,
): boolean {
  const leftNormalized = normalizeExecutablePath(leftExecutablePath, options);
  const rightNormalized = normalizeExecutablePath(rightExecutablePath, options);

  if (getCurrentPlatform(options) === 'darwin') {
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

export interface AntigravityProcessCandidate {
  name: string;
  commandLine: string;
  executablePath?: string;
  /** Complete native argv, including the executable; avoids lossy command-line reconstruction. */
  args?: readonly string[];
}

export function isTargetAntigravityProcessCandidate(
  processItem: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): boolean {
  if (isAntigravityWindowsInstaller(processItem.name)) {
    return false;
  }
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const nameLower = processItem.name.toLowerCase();
  const cmdLower = processItem.commandLine.toLowerCase();
  const configuredClassicPath = options?.ignoreExecutableConfiguration
    ? null
    : getConfiguredAntigravityExecutablePath('classic', false, options);
  const configuredIdePath = options?.ignoreExecutableConfiguration
    ? null
    : getConfiguredAntigravityExecutablePath('ide', false, options);
  const strictConfiguredClassicPath = options?.ignoreExecutableConfiguration
    ? null
    : getConfiguredAntigravityExecutablePath('classic', true, options);
  const strictConfiguredIdePath = options?.ignoreExecutableConfiguration
    ? null
    : getConfiguredAntigravityExecutablePath('ide', true, options);
  const args = processItem.args ?? parseCommandLineArguments(processItem.commandLine);
  const commandExecutablePath = args[0] || '';
  const processExecutablePath = processItem.executablePath ?? '';
  const executableTarget = getAntigravityExecutableTarget(
    processExecutablePath || commandExecutablePath || processItem.name,
  );
  const matchesClassicPath =
    configuredClassicPath !== null &&
    processExecutablePath !== '' &&
    areExecutablePathsEquivalent(configuredClassicPath, processExecutablePath, options);
  const matchesIdePath =
    configuredIdePath !== null &&
    processExecutablePath !== '' &&
    areExecutablePathsEquivalent(configuredIdePath, processExecutablePath, options);
  const isIde = executableTarget === 'ide' || matchesIdePath;

  if (isAntigravityHelperProcess(nameLower, args)) {
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
    (executableTarget === 'classic' || matchesClassicPath) &&
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
  options?: PathResolutionOptions,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const executablePath = processItem.executablePath || '';
  if (!executablePath) {
    return false;
  }
  if (
    isAntigravityHelperProcess(
      processItem.name,
      processItem.args ?? parseCommandLineArguments(processItem.commandLine),
    )
  ) {
    return false;
  }

  const configuredClassicPath = getConfiguredAntigravityExecutablePath('classic', true, options);
  const configuredIdePath = getConfiguredAntigravityExecutablePath('ide', true, options);
  const matchesClassicPath =
    configuredClassicPath !== null &&
    areExecutablePathsEquivalent(configuredClassicPath, executablePath, options);
  const matchesIdePath =
    configuredIdePath !== null &&
    areExecutablePathsEquivalent(configuredIdePath, executablePath, options);

  if (normalizedTarget === 'ide') {
    return matchesIdePath && !matchesClassicPath;
  }

  return matchesClassicPath && !matchesIdePath;
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

function extractUserDataDirectoryFromArgs(
  commandLineArguments: string[],
  options?: PathResolutionOptions,
): string | null {
  const pathApi = getCurrentPlatformPathApi(options);

  for (let index = 0; index < commandLineArguments.length; index += 1) {
    const argument = commandLineArguments[index];

    if (argument === '--user-data-dir' && commandLineArguments[index + 1]) {
      return pathApi.resolve(commandLineArguments[index + 1]);
    }

    if (argument.startsWith('--user-data-dir=')) {
      const userDataDir = argument.slice('--user-data-dir='.length);
      if (userDataDir) {
        return pathApi.resolve(userDataDir);
      }
    }
  }

  return null;
}

function readAntigravityManagerConfig(
  options?: PathResolutionOptions,
): AntigravityManagerConfig | null {
  const pathApi = getCurrentPlatformPathApi(options);
  const configPaths = [
    pathApi.join(getAgentDir(options), CONFIG_FILENAME),
    pathApi.join(getAppDataDir(undefined, options), CONFIG_FILENAME),
  ];

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }

      const rawConfig: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const parsedConfig = AntigravityManagerConfigSchema.safeParse(rawConfig);
      if (parsedConfig.success) {
        return parsedConfig.data;
      }
    } catch {
      continue;
    }
  }

  return null;
}

interface RunningAntigravityProcess {
  args: string[];
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

interface RefreshProcessCacheOptions extends PathResolutionOptions {
  includeAllProcesses?: boolean;
}

function processInfoToRunningProcess(processInfo: ProcessInfo): RunningAntigravityProcess {
  return {
    pid: processInfo.pid,
    name: processInfo.name,
    executablePath: processInfo.exe ?? '',
    commandLine: processInfo.cmd.join(' '),
    args: processInfo.cmd,
  };
}

export async function refreshAntigravityProcessCache(
  target?: AntigravityAppTarget | null,
  options: RefreshProcessCacheOptions = {},
): Promise<void> {
  const resolvedTarget = resolveAntigravityAppTarget(target);

  const processMap = new Map<number, RunningAntigravityProcess>();

  try {
    const matches = await readNativeProcessSnapshot(PROCESS_SCAN_TIMEOUT_MS);
    for (const processInfo of matches) {
      if (!options.includeAllProcesses && !/antigravity/i.test(processInfo.name)) {
        continue;
      }
      const runningProcess = processInfoToRunningProcess(processInfo);
      if (
        runningProcess.pid > 0 &&
        runningProcess.executablePath &&
        isTargetAntigravityProcessCandidate(runningProcess, target, options)
      ) {
        processMap.set(runningProcess.pid, runningProcess);
      }
    }
  } catch {
    // Process discovery is opportunistic. Standard and portable path fallbacks still apply.
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

function getUserDataDirFromRunningProcess(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string | null {
  const configuredUserDataDir = extractUserDataDirectoryFromArgs(
    getConfiguredAntigravityArgs(target, options),
    options,
  );
  if (configuredUserDataDir && fs.existsSync(configuredUserDataDir)) {
    return configuredUserDataDir;
  }

  for (const commandLineArguments of getAntigravityArgsFromRunningProcess(target)) {
    const userDataDir = extractUserDataDirectoryFromArgs(commandLineArguments, options);
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
    .map((processItem) => [...processItem.args])
    .filter((commandLineArguments) => commandLineArguments.length > 0);
}

export function getAntigravityLaunchArgsFromRunningProcess(
  target?: AntigravityAppTarget | null,
): string[] {
  return getAntigravityArgsFromRunningProcess(target)[0]?.slice(1) || [];
}

export function getConfiguredAntigravityArgs(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string[] {
  const rawConfig = readAntigravityManagerConfig(options);
  const configKey =
    resolveAntigravityAppTarget(target) === 'ide' ? 'antigravity_ide_args' : 'antigravity_args';
  const configuredArgs = rawConfig?.[configKey];

  return configuredArgs ?? [];
}

export function getConfiguredAntigravityExecutablePath(
  target?: AntigravityAppTarget | null,
  requireExists = true,
  options?: PathResolutionOptions,
): string | null {
  const rawConfig = readAntigravityManagerConfig(options);
  const configKey =
    resolveAntigravityAppTarget(target) === 'ide'
      ? 'antigravity_ide_executable'
      : 'antigravity_executable';
  const configuredPath = rawConfig?.[configKey];

  const executablePath = configuredPath?.trim();
  if (!executablePath) {
    return null;
  }
  if (requireExists && !fs.existsSync(executablePath)) {
    return null;
  }

  return executablePath;
}

function pushUserDataDbPaths(paths: string[], userDataDir: string, pathApi: PathApi): void {
  appendUniquePath(paths, pathApi.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'));
  appendUniquePath(paths, pathApi.join(userDataDir, 'User', 'state.vscdb'));
  appendUniquePath(paths, pathApi.join(userDataDir, 'state.vscdb'));
}

function pushUserDataStoragePaths(paths: string[], userDataDir: string, pathApi: PathApi): void {
  appendUniquePath(paths, pathApi.join(userDataDir, 'User', 'globalStorage', 'storage.json'));
  appendUniquePath(paths, pathApi.join(userDataDir, 'User', 'storage.json'));
  appendUniquePath(paths, pathApi.join(userDataDir, 'storage.json'));
}

function pushExistingUserDataDbPaths(paths: string[], userDataDir: string, pathApi: PathApi): void {
  const candidates: string[] = [];
  pushUserDataDbPaths(candidates, userDataDir, pathApi);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      appendUniquePath(paths, candidate);
    }
  }
}

function pushExistingUserDataStoragePaths(
  paths: string[],
  userDataDir: string,
  pathApi: PathApi,
): void {
  const candidates: string[] = [];
  pushUserDataStoragePaths(candidates, userDataDir, pathApi);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      appendUniquePath(paths, candidate);
    }
  }
}

export function getPortableUserDataDir(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string | null {
  const executablePath = options?.executablePath ?? getAntigravityExecutablePath(target, options);
  if (!executablePath) {
    return null;
  }

  const pathApi = getCurrentPlatformPathApi(options);
  const userDataDir = pathApi.join(pathApi.dirname(executablePath), 'data', 'user-data');

  if (getCurrentPlatform(options) !== 'win32') {
    try {
      fs.accessSync(userDataDir, fs.constants.W_OK);
    } catch {
      return null;
    }
  }

  return userDataDir;
}

export function getAppDataDir(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string {
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);

  if (resolveIsWsl(options)) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Roaming/${folderName}`;
  }

  switch (getCurrentPlatform(options)) {
    case 'darwin':
      return path.posix.join(home, 'Library', 'Application Support', folderName);
    case 'win32':
      return path.win32.join(
        process.env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'),
        folderName,
      );
    case 'linux':
      return path.posix.join(home, '.config', folderName);
    default:
      return path.posix.join(home, '.antigravity');
  }
}

/**
 * Resolves the host Antigravity extensions directory.
 * E.g., ~/.antigravity/extensions on Linux and macOS,
 * %USERPROFILE%\.antigravity\extensions on Windows,
 * /mnt/c/Users/${winUser}/.antigravity/extensions on WSL.
 */
export function getAntigravityExtensionsDir(options?: PathResolutionOptions): string {
  const home = os.homedir();
  if (resolveIsWsl(options)) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/.antigravity/extensions`;
  }

  const currentPlatform = getCurrentPlatform(options);
  if (currentPlatform === 'win32') {
    const userProfile = process.env.USERPROFILE || home;
    return path.win32.join(userProfile, '.antigravity', 'extensions');
  }

  return path.posix.join(home, '.antigravity', 'extensions');
}

/**
 * Resolves the host Antigravity User configuration directory.
 * E.g., ~/.config/Antigravity/User on Linux,
 * ~/Library/Application Support/Antigravity/User on macOS,
 * %APPDATA%\Antigravity\User on Windows.
 */
export function getAntigravityHostUserDir(options?: PathResolutionOptions): string {
  const classicAppData = getAppDataDir('classic', options);
  const pathApi = getCurrentPlatformPathApi(options);
  return pathApi.join(classicAppData, 'User');
}

export function getAgentDir(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(os.homedir(), '.antigravity-agent');
}

export function getAccountsFilePath(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'antigravity_accounts.json');
}

export function getBackupsDir(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'backups');
}

/** Directory holding proxy state that has to survive an app restart. */
export function getProxyStateDir(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'proxy-state');
}

export function getCloudAccountsDbPath(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'cloud_accounts.db');
}

/**
 * Resolves the base directory where isolated workspace profiles are stored.
 * E.g., ~/.config/AntigravityManager/profiles on Linux,
 * %APPDATA%\AntigravityManager\profiles on Windows,
 * ~/Library/Application Support/AntigravityManager/profiles on macOS.
 */
export function getProfilesBaseDir(options?: PathResolutionOptions): string {
  const pathApi = getCurrentPlatformPathApi(options);
  return pathApi.join(getAppDataDir(undefined, options), '..', 'AntigravityManager', 'profiles');
}

/**
 * Resolves the dedicated user data directory for a specific workspace profile.
 * E.g., ~/.config/AntigravityManager/profiles/<profileId> on Linux.
 * Strictly enforces that profileId is a safe identifier and never escapes the profiles base directory.
 */
export function getProfileUserDataDir(profileId: string, options?: PathResolutionOptions): string {
  const safeId = typeof profileId === 'string' ? profileId.trim() : '';
  if (!safeId || safeId === '.' || safeId === '..' || !/^[a-zA-Z0-9_-]+$/.test(safeId)) {
    throw new Error(
      `Invalid workspace profile ID: "${profileId}". Profile ID must only contain alphanumeric characters, dashes, and underscores.`,
    );
  }

  const pathApi = getCurrentPlatformPathApi(options);
  const baseDir = pathApi.resolve(getProfilesBaseDir(options));
  const resolved = pathApi.resolve(baseDir, safeId);
  const relative = pathApi.relative(baseDir, resolved);

  if (relative === '' || relative.startsWith('..') || pathApi.isAbsolute(relative)) {
    throw new Error(`Invalid workspace profile ID: "${profileId}" escapes profiles directory.`);
  }

  return resolved;
}

export function getAntigravityDbPaths(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string[] {
  if (options?.userDataDir) {
    const paths: string[] = [];
    pushUserDataDbPaths(paths, options.userDataDir, getCurrentPlatformPathApi(options));
    return paths;
  }
  const appData = getAppDataDir(target, options);
  const paths: string[] = [];
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);
  const pathApi = getCurrentPlatformPathApi(options);
  const userDataDir = getUserDataDirFromRunningProcess(target, options);
  const portableUserDataDir = getPortableUserDataDir(target, options);

  if (userDataDir) {
    pushExistingUserDataDbPaths(paths, userDataDir, pathApi);
  }

  if (portableUserDataDir) {
    pushExistingUserDataDbPaths(paths, portableUserDataDir, pathApi);
  }

  if (resolveIsWsl(options)) {
    // Assume standard structure: AppData/Roaming/Antigravity/User/globalStorage/state.vscdb
    // appData is already resolved to Roaming/Antigravity in getAppDataDir()
    pushUserDataDbPaths(paths, appData, path.posix);
    return paths;
  }

  if (getCurrentPlatform(options) === 'linux') {
    pushUserDataDbPaths(paths, appData, path.posix);
    return paths;
  }

  if (getCurrentPlatform(options) === 'darwin') {
    // Standard path
    appendUniquePath(
      paths,
      path.posix.join(
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
      path.posix.join(home, 'Library', 'Application Support', folderName, 'state.vscdb'),
    );
    return paths;
  }

  // Windows
  // Standard path
  appendUniquePath(paths, path.win32.join(appData, 'User', 'globalStorage', 'state.vscdb'));
  // Fallback paths
  appendUniquePath(paths, path.win32.join(appData, 'User', 'state.vscdb'));
  appendUniquePath(paths, path.win32.join(appData, 'state.vscdb'));

  return paths;
}

export function getAntigravityStoragePaths(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string[] {
  if (options?.userDataDir) {
    const paths: string[] = [];
    pushUserDataStoragePaths(paths, options.userDataDir, getCurrentPlatformPathApi(options));
    return paths;
  }
  const appData = getAppDataDir(target, options);
  const paths: string[] = [];
  const home = os.homedir();
  const folderName = getAntigravityAppFolderName(target);
  const pathApi = getCurrentPlatformPathApi(options);
  const userDataDir = getUserDataDirFromRunningProcess(target, options);
  const portableUserDataDir = getPortableUserDataDir(target, options);

  if (userDataDir) {
    pushExistingUserDataStoragePaths(paths, userDataDir, pathApi);
  }

  if (portableUserDataDir) {
    pushExistingUserDataStoragePaths(paths, portableUserDataDir, pathApi);
  }

  if (resolveIsWsl(options)) {
    pushUserDataStoragePaths(paths, appData, path.posix);
    return paths;
  }

  if (getCurrentPlatform(options) === 'linux') {
    pushUserDataStoragePaths(paths, appData, path.posix);
    return paths;
  }

  if (getCurrentPlatform(options) === 'darwin') {
    appendUniquePath(
      paths,
      path.posix.join(
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
      path.posix.join(home, 'Library', 'Application Support', folderName, 'storage.json'),
    );
    return paths;
  }

  appendUniquePath(paths, path.win32.join(appData, 'User', 'globalStorage', 'storage.json'));
  appendUniquePath(paths, path.win32.join(appData, 'User', 'storage.json'));
  appendUniquePath(paths, path.win32.join(appData, 'storage.json'));
  return paths;
}

export function getAntigravityStoragePath(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string {
  const paths = getAntigravityStoragePaths(target, options);
  return paths.length > 0 ? paths[0] : '';
}

// Keep for backward compatibility if needed, but prefer getAntigravityDbPaths
export function getAntigravityDbPath(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string {
  const paths = getAntigravityDbPaths(target, options);
  return paths.length > 0 ? paths[0] : '';
}

export function getAntigravityExecutablePath(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const executableName = getAntigravityAppFolderName(target);
  const runningExecutablePath = options?.ignoreRunningProcessCache
    ? null
    : getExecutablePathFromRunningProcess(target);

  if (runningExecutablePath) {
    return runningExecutablePath;
  }

  const configuredExecutablePath = getConfiguredAntigravityExecutablePath(
    resolvedTarget,
    undefined,
    options,
  );
  if (configuredExecutablePath) {
    return configuredExecutablePath;
  }

  if (resolveIsWsl(options)) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Local/Programs/${executableName}/${executableName}.exe`;
  }

  switch (getCurrentPlatform(options)) {
    case 'darwin':
      return `/Applications/${executableName}.app/Contents/MacOS/${executableName}`;
    case 'win32': {
      return findWindowsClientExecutables(resolvedTarget === 'ide' ? 'ide' : 'classic')[0] || '';
    }
    case 'linux': {
      const possibleLinuxPaths =
        resolvedTarget === 'ide'
          ? [
              '/usr/bin/antigravity-ide',
              '/usr/local/bin/antigravity-ide',
              '/opt/Antigravity IDE/antigravity-ide',
              '/opt/antigravity-ide/antigravity-ide',
              path.posix.join(
                os.homedir(),
                '.local',
                'share',
                'antigravity-ide',
                'antigravity-ide',
              ),
            ]
          : [
              '/usr/bin/antigravity',
              '/usr/local/bin/antigravity',
              '/usr/share/antigravity/antigravity',
              '/opt/Antigravity/antigravity',
              '/opt/antigravity/antigravity',
              path.posix.join(os.homedir(), '.local', 'share', 'antigravity', 'antigravity'),
            ];

      for (const possiblePath of possibleLinuxPaths) {
        if (fs.existsSync(possiblePath)) {
          return possiblePath;
        }
      }

      // Fallback: try `which antigravity` via path lookup
      const binaryName = resolvedTarget === 'ide' ? 'antigravity-ide' : 'antigravity';
      const fromPath = process.env.PATH?.split(':')
        .map((dir) => path.posix.join(dir, binaryName))
        .find((possiblePath) => fs.existsSync(possiblePath));
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
