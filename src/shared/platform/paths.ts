import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import findProcess, { type ProcessInfo } from 'find-process';
import type { AntigravityAppTarget } from '@/modules/account/types';
import { resolveAntigravityAppTarget } from '@/modules/account/types';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';

type PathApi = Pick<typeof path, 'dirname' | 'join' | 'normalize' | 'resolve'>;

export interface PathResolutionOptions {
  platform?: NodeJS.Platform;
  isWsl?: boolean;
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
  const normalizedPath = pathApi.normalize(pathForComparison).toLowerCase();

  if (getCurrentPlatform(options) === 'win32') {
    return normalizedPath.replace(/\//g, '\\');
  }

  return normalizedPath;
}

function areExecutablePathsEquivalent(
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
  options?: PathResolutionOptions,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const nameLower = processItem.name.toLowerCase();
  const cmdLower = processItem.commandLine.toLowerCase();
  const configuredClassicPath = getConfiguredAntigravityExecutablePath('classic', false, options);
  const configuredIdePath = getConfiguredAntigravityExecutablePath('ide', false, options);
  const strictConfiguredClassicPath = getConfiguredAntigravityExecutablePath(
    'classic',
    true,
    options,
  );
  const strictConfiguredIdePath = getConfiguredAntigravityExecutablePath('ide', true, options);
  const commandExecutablePath = parseCommandLineArguments(processItem.commandLine)[0] || '';
  const executableIdentity = `${processItem.executablePath || ''} ${commandExecutablePath}`;
  const hasAntigravityProcessIdentity =
    nameLower.includes('antigravity') || executableIdentity.toLowerCase().includes('antigravity');
  const matchesClassicPath =
    Boolean((configuredClassicPath && processItem.executablePath) || '') &&
    areExecutablePathsEquivalent(
      configuredClassicPath as string,
      processItem.executablePath || '',
      options,
    );
  const matchesIdePath =
    Boolean((configuredIdePath && processItem.executablePath) || '') &&
    areExecutablePathsEquivalent(
      configuredIdePath as string,
      processItem.executablePath || '',
      options,
    );
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
  options?: PathResolutionOptions,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const executablePath = processItem.executablePath || '';
  if (!executablePath) {
    return false;
  }

  const configuredClassicPath = getConfiguredAntigravityExecutablePath('classic', true, options);
  const configuredIdePath = getConfiguredAntigravityExecutablePath('ide', true, options);
  const matchesClassicPath =
    Boolean(configuredClassicPath) &&
    areExecutablePathsEquivalent(configuredClassicPath as string, executablePath, options);
  const matchesIdePath =
    Boolean(configuredIdePath) &&
    areExecutablePathsEquivalent(configuredIdePath as string, executablePath, options);

  if (normalizedTarget === 'ide') {
    return matchesIdePath && !matchesClassicPath;
  }

  return matchesClassicPath && !matchesIdePath;
}

export function isTargetAntigravityExecutableProcessCandidate(
  processItem: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): boolean {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const oppositeTarget: AntigravityAppTarget = normalizedTarget === 'ide' ? 'classic' : 'ide';
  const executablePath =
    processItem.executablePath ||
    resolveExecutablePathFromProcessInfo(null, processItem.commandLine);

  if (!executablePath) {
    return false;
  }

  const targetExecutablePath = getAntigravityExecutablePath(normalizedTarget, options);
  if (!targetExecutablePath) {
    return false;
  }

  if (!areExecutablePathsEquivalent(targetExecutablePath, executablePath, options)) {
    return false;
  }

  const oppositeExecutablePath = getAntigravityExecutablePath(oppositeTarget, options);
  return !(
    oppositeExecutablePath &&
    areExecutablePathsEquivalent(oppositeExecutablePath, executablePath, options)
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

function readAntigravityManagerConfig(options?: PathResolutionOptions): {
  antigravity_executable?: unknown;
  antigravity_ide_executable?: unknown;
  antigravity_args?: unknown;
  antigravity_ide_args?: unknown;
} | null {
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

interface RefreshProcessCacheOptions extends PathResolutionOptions {
  includeAllProcesses?: boolean;
}

function processInfoToRunningProcess(processInfo: ProcessInfo): RunningAntigravityProcess {
  const commandLine = processInfo.cmd || processInfo.name || '';
  return {
    pid: processInfo.pid,
    name: processInfo.name || '',
    executablePath: resolveExecutablePathFromProcessInfo(processInfo.bin, commandLine),
    commandLine,
  };
}

function getProcessSearchNames(
  target?: AntigravityAppTarget | null,
  includeAllProcesses = false,
): string[] {
  const searchNames =
    resolveAntigravityAppTarget(target) === 'ide'
      ? ['Antigravity IDE', 'antigravity-ide', 'Antigravity', 'antigravity']
      : ['Antigravity', 'antigravity'];

  if (includeAllProcesses) {
    searchNames.push('');
  }

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
  options: RefreshProcessCacheOptions = {},
): Promise<void> {
  const resolvedTarget = resolveAntigravityAppTarget(target);

  const processMap = new Map<number, RunningAntigravityProcess>();

  for (const searchName of getProcessSearchNames(target, options.includeAllProcesses)) {
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
        if (
          runningProcess.pid > 0 &&
          isTargetAntigravityProcessCandidate(runningProcess, target, options)
        ) {
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
    .map((processItem) => parseCommandLineArguments(processItem.commandLine))
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

  if (!Array.isArray(configuredArgs)) {
    return [];
  }

  return configuredArgs.filter((arg): arg is string => typeof arg === 'string');
}

function getConfiguredAntigravityExecutablePath(
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

function getPortableUserDataDir(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string | null {
  const executablePath = getAntigravityExecutablePath(target, options);
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

export function getAgentDir(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(os.homedir(), '.antigravity-agent');
}

export function getAccountsFilePath(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'antigravity_accounts.json');
}

export function getBackupsDir(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'backups');
}

export function getCloudAccountsDbPath(options?: PathResolutionOptions): string {
  return getCurrentPlatformPathApi(options).join(getAgentDir(options), 'cloud_accounts.db');
}

const AGY_CLI_DIR_SEGMENTS = ['.gemini', 'antigravity-cli'] as const;
const AGY_CLI_TOKEN_FILE = 'antigravity-oauth-token';
const WSL_DISTRO_CACHE_TTL_MS = 60_000;

// A remote WSL share cannot answer for its own PATH, so a system-wide install
// there is matched against the locations `agy` is actually distributed to,
// rather than a full PATH scan like the local host gets.
const AGY_CLI_WSL_HOME_EXECUTABLE_SEGMENTS = ['.local', 'bin', 'agy'] as const;
const AGY_CLI_WSL_SYSTEM_EXECUTABLE_SEGMENTS: readonly (readonly string[])[] = [
  ['usr', 'local', 'bin', 'agy'],
  ['usr', 'bin', 'agy'],
];

let cachedRunningWslDistros: { names: string[]; readAt: number } | null = null;

/**
 * Lists the WSL distributions that are already running on this Windows host.
 *
 * Deliberately `--running` rather than every registered distribution: reading
 * `\\wsl.localhost\<distro>` starts a stopped distribution, and waking WSL
 * behind the user's back to refresh a token is a worse trade than letting the
 * CLI there pick up the account on the next switch. The answer is cached
 * briefly because automatic account rotation calls this in bursts.
 *
 * @param {NodeJS.Platform} platform The platform to answer for, so the caller's
 * resolved platform stays the single source of truth rather than the machine
 * this happens to run on.
 */
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
    // wsl.exe answers in UTF-16LE for a Windows caller but in UTF-8 through
    // interop, so decode by what the bytes actually look like.
    const raw = execSync('wsl.exe -l -q --running', {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf-8');
    names = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((line) => line.length > 0);
  } catch {
    // No WSL, or wsl.exe refused to answer: no distributions to serve.
    names = [];
  }

  cachedRunningWslDistros = { names, readAt: now };
  return names;
}

function listWslHomeDirs(distroRoot: string): string[] {
  const homes = [path.win32.join(distroRoot, 'root')];

  try {
    const entries = fs.readdirSync(path.win32.join(distroRoot, 'home'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        homes.push(path.win32.join(distroRoot, 'home', entry.name));
      }
    }
  } catch {
    // A distribution without a readable /home contributes nothing.
  }

  return homes;
}

/**
 * Whether a WSL distribution's home has an `agy` executable reachable from
 * this share: the user-local install, or one of the system-wide locations
 * `agy` is actually distributed to. See the doc comment on
 * `getAgyCliTokenPaths()` for why this cannot fall back to a `PATH` scan.
 */
function hasWslAgyCliExecutable(
  exists: (candidatePath: string) => boolean,
  distroRoot: string,
  home: string,
): boolean {
  if (exists(path.win32.join(home, ...AGY_CLI_WSL_HOME_EXECUTABLE_SEGMENTS))) {
    return true;
  }

  return AGY_CLI_WSL_SYSTEM_EXECUTABLE_SEGMENTS.some((segments) =>
    exists(path.win32.join(distroRoot, ...segments)),
  );
}

export interface GetAgyCliTokenPathsOptions {
  exists?: (candidatePath: string) => boolean;
  homeDirectory?: string;
  listRunningWslDistros?: () => string[];
  listWslHomeDirsForDistro?: (distroRoot: string) => string[];
  pathEnvironment?: string;
  platform?: NodeJS.Platform;
}

/**
 * Token files of the Antigravity CLI (`agy`) this machine can write.
 *
 * The CLI keeps its session in a plain file instead of the credential store
 * the IDE reads, and a Windows host can also reach the copies inside its
 * running WSL distributions. Two separate conditions gate each candidate:
 *
 * 1. `agy` is actually installed there — for the local host, detected the
 *    same way `detectAgyCliExecutablePath()` is (user-local `~/.local/bin/agy`
 *    first, then `PATH`); for a WSL home, a remote share cannot answer for
 *    its own `PATH`, so the check instead matches `~/.local/bin/agy` plus the
 *    handful of system-wide locations `agy` is actually distributed to
 *    (`/usr/local/bin`, `/usr/bin`).
 * 2. The session directory (`~/.gemini/antigravity-cli`) already exists —
 *    `agy` creates it on first login, so its absence means the CLI is
 *    installed but was never signed in. Writing there would fail with ENOENT
 *    on every account switch, and the function must not create the directory
 *    itself: the point is to keep CLI installs on the same account as the
 *    IDE, not to provision the CLI where it was never set up.
 *
 * Every dependency is overridable through `options` so the unit suite can
 * exercise this without touching the real home directory or spawning
 * `wsl.exe` - production call sites invoke it with no options.
 */
export function getAgyCliTokenPaths(options: GetAgyCliTokenPathsOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const localPathApi = platform === 'win32' ? path.win32 : path.posix;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const exists = options.exists ?? ((candidatePath: string) => fs.existsSync(candidatePath));
  const pathEnvironment = options.pathEnvironment ?? process.env.PATH;
  const listRunningWslDistros =
    options.listRunningWslDistros ?? (() => getRunningWslDistros(platform));
  const listWslHomeDirsForDistro = options.listWslHomeDirsForDistro ?? listWslHomeDirs;

  const paths: string[] = [];

  const localExecutablePath = detectAgyCliExecutablePath({
    exists,
    homeDirectory,
    pathEnvironment,
    platform,
  });
  if (localExecutablePath) {
    const sessionDir = localPathApi.join(homeDirectory, ...AGY_CLI_DIR_SEGMENTS);
    if (exists(sessionDir)) {
      appendUniquePath(paths, localPathApi.join(sessionDir, AGY_CLI_TOKEN_FILE));
    }
  }

  if (platform === 'win32') {
    for (const distro of listRunningWslDistros()) {
      const distroRoot = `\\\\wsl.localhost\\${distro}`;
      for (const home of listWslHomeDirsForDistro(distroRoot)) {
        if (!hasWslAgyCliExecutable(exists, distroRoot, home)) {
          continue;
        }

        const sessionDir = path.win32.join(home, ...AGY_CLI_DIR_SEGMENTS);
        if (!exists(sessionDir)) {
          continue;
        }

        appendUniquePath(paths, path.win32.join(sessionDir, AGY_CLI_TOKEN_FILE));
      }
    }
  }

  return paths;
}

export function getAntigravityDbPaths(
  target?: AntigravityAppTarget | null,
  options?: PathResolutionOptions,
): string[] {
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
  const runningExecutablePath = getExecutablePathFromRunningProcess(target);

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
      const localAppData = process.env.LOCALAPPDATA || '';
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

      const possiblePaths = [
        path.win32.join(localAppData, 'Programs', executableName, `${executableName}.exe`),
        path.win32.join(programFiles, executableName, `${executableName}.exe`),
        path.win32.join(programFilesX86, executableName, `${executableName}.exe`),
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
