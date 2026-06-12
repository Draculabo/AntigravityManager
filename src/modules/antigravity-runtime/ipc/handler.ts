import { exec, execSync, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import findProcess, { ProcessInfo } from 'find-process';
import { isNumber, isString } from 'lodash-es';
import {
  type AntigravityProcessCandidate,
  getAntigravityExecutablePath,
  getConfiguredAntigravityArgs,
  isConfiguredTargetExecutableProcessCandidate,
  isTargetAntigravityExecutableProcessCandidate,
  isTargetAntigravityProcessCandidate,
  isWsl,
} from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import type { AntigravityAppTarget } from '@/modules/account/types';
import { resolveAntigravityAppTarget } from '@/modules/account/types';
import {
  isSafeWindowsImageName,
  isWindowsImageRunning,
  killWindowsImageTree,
  queryWindowsProcessesByImageName,
} from '@/shared/platform/windowsProcess';

const execAsync = promisify(exec);
const PROCESS_STARTUP_TIMEOUT_MS = 6000;
const PROCESS_STARTUP_POLL_INTERVAL_MS = 200;
const WINDOWS_FIND_PROCESS_DIAGNOSTIC_TIMEOUT_MS = 3000;
const WINDOWS_FIND_PROCESS_DIAGNOSTIC_INTERVAL_MS = 10 * 60 * 1000;
const WINDOWS_CIM_PROBE_COMMAND =
  "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process -Property Name,ProcessId,ParentProcessId,CommandLine,ExecutablePath | Select-Object -First 1 | Out-Null";
const LINUX_GPU_SAFE_LAUNCH_ARGS = ['--disable-gpu', '--disable-gpu-compositing'] as const;
let lastWindowsFindProcessDiagnosticAt = 0;

function isPgrepNoMatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const hasPgrep = message.includes('pgrep') && message.includes('antigravity');
  const code = (error as { code?: number }).code;
  return hasPgrep && code === 1;
}

function getProcessSearchNames(
  target?: AntigravityAppTarget | null,
  includeAllProcesses = false,
): string[] {
  const normalizedTarget = resolveAntigravityAppTarget(target);
  const searchNames =
    normalizedTarget === 'ide'
      ? ['Antigravity IDE', 'antigravity-ide', 'Antigravity', 'antigravity']
      : ['Antigravity', 'antigravity'];

  if (process.platform === 'linux') {
    searchNames.push('electron');
  }
  if (includeAllProcesses) {
    searchNames.push('');
  }

  return searchNames;
}

function getWindowsTargetImageNames(target?: AntigravityAppTarget | null): string[] {
  const imageNames = new Set<string>();
  const defaultImageName =
    resolveAntigravityAppTarget(target) === 'ide' ? 'Antigravity IDE.exe' : 'Antigravity.exe';
  imageNames.add(defaultImageName);

  const executablePath = getAntigravityExecutablePath(target);
  if (executablePath) {
    const executableImageName = path.win32.basename(executablePath);
    if (isSafeWindowsImageName(executableImageName)) {
      imageNames.add(executableImageName);
    }
  }

  return Array.from(imageNames).filter(isSafeWindowsImageName);
}

function isAnyWindowsTargetImageRunning(target?: AntigravityAppTarget | null): boolean | null {
  let sawCommandFailure = false;
  for (const imageName of getWindowsTargetImageNames(target)) {
    const isRunning = isWindowsImageRunning(imageName);
    if (isRunning === true) {
      return true;
    }
    if (isRunning === null) {
      sawCommandFailure = true;
    }
  }

  return sawCommandFailure ? null : false;
}

function killWindowsTargetImages(target?: AntigravityAppTarget | null): boolean {
  let killedAny = false;
  for (const imageName of getWindowsTargetImageNames(target)) {
    if (killWindowsImageTree(imageName)) {
      killedAny = true;
    }
  }

  return killedAny;
}

function findWindowsAntigravityProcesses(target?: AntigravityAppTarget | null): ProcessInfo[] {
  const processMap = new Map<number, ProcessInfo>();

  for (const imageName of getWindowsTargetImageNames(target)) {
    const processes = queryWindowsProcessesByImageName(imageName);
    if (!processes) {
      continue;
    }

    for (const processItem of processes) {
      processMap.set(processItem.pid, {
        pid: processItem.pid,
        ppid: 0,
        name: processItem.name,
        bin: processItem.executablePath,
        cmd: processItem.commandLine,
      });
    }
  }

  return Array.from(processMap.values());
}

function truncateDiagnosticValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 1000);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  const output = (error as { [K in typeof key]?: unknown })?.[key];
  return isString(output) ? truncateDiagnosticValue(output) : '';
}

async function getWindowsFindProcessDiagnostic(error: unknown): Promise<Record<string, string>> {
  const diagnostic = {
    findProcessError: truncateDiagnosticValue(getErrorMessage(error)),
  };

  try {
    await execAsync(
      `powershell.exe -NoProfile -NonInteractive -Command "${WINDOWS_CIM_PROBE_COMMAND}"`,
      {
        timeout: WINDOWS_FIND_PROCESS_DIAGNOSTIC_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    return {
      ...diagnostic,
      noProfileCimProbe: 'ok',
      probableCause:
        'PowerShell profile or interactive shell startup is likely interfering with find-process',
    };
  } catch (probeError) {
    return {
      ...diagnostic,
      noProfileCimProbe: 'failed',
      noProfileError: truncateDiagnosticValue(getErrorMessage(probeError)),
      noProfileStdout: getErrorOutput(probeError, 'stdout'),
      noProfileStderr: getErrorOutput(probeError, 'stderr'),
      probableCause: 'WMI/CIM, permissions, or endpoint policy may be blocking Win32_Process',
    };
  }
}

async function reportWindowsFindProcessFailure(error: unknown): Promise<void> {
  const now = Date.now();
  if (now - lastWindowsFindProcessDiagnosticAt < WINDOWS_FIND_PROCESS_DIAGNOSTIC_INTERVAL_MS) {
    logger.warn('find-process Windows scan failed; using Windows image-name fallback', {
      findProcessError: truncateDiagnosticValue(getErrorMessage(error)),
      diagnosticSkipped: 'rate_limited',
    });
    return;
  }

  lastWindowsFindProcessDiagnosticAt = now;
  logger.warn(
    'find-process Windows scan failed; using Windows image-name fallback',
    await getWindowsFindProcessDiagnostic(error),
  );
}

async function findAntigravityProcesses(
  target?: AntigravityAppTarget | null,
  includeAllProcesses = false,
): Promise<ProcessInfo[]> {
  const allMatches: ProcessInfo[] = [];
  let sawNoMatch = false;
  let windowsFindProcessError: unknown = null;

  for (const searchName of getProcessSearchNames(target, includeAllProcesses)) {
    try {
      const matches = await findProcess('name', searchName, false);
      allMatches.push(...matches);
    } catch (error) {
      if (isPgrepNoMatchError(error)) {
        sawNoMatch = true;
        continue;
      }
      if (process.platform === 'win32') {
        windowsFindProcessError = error;
        break;
      }
      throw error;
    }
  }

  if (windowsFindProcessError) {
    await reportWindowsFindProcessFailure(windowsFindProcessError);
    return findWindowsAntigravityProcesses(target);
  }

  const processMap = new Map<number, ProcessInfo>();
  for (const processInfo of allMatches) {
    if (isNumber(processInfo.pid)) {
      processMap.set(processInfo.pid, processInfo);
    }
  }

  const processes = Array.from(processMap.values());
  if (processes.length === 0 && sawNoMatch) {
    logger.debug('No Antigravity process found (pgrep returned 1)');
  }

  logger.debug(`Found ${processes.length} processes matching 'Antigravity/antigravity'`);
  return processes;
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

function mapProcessInfoToCandidate(processInfo: ProcessInfo): AntigravityProcessCandidate {
  const commandLine = processInfo.cmd || processInfo.name || '';
  return {
    name: processInfo.name || '',
    commandLine,
    executablePath: processInfo.bin || parseCommandLineArguments(commandLine)[0] || '',
  };
}

function isClosableTargetProcessCandidate(
  candidate: AntigravityProcessCandidate,
  target?: AntigravityAppTarget | null,
): boolean {
  return (
    isTargetAntigravityExecutableProcessCandidate(candidate, target) ||
    isConfiguredTargetExecutableProcessCandidate(candidate, target) ||
    isTargetAntigravityProcessCandidate(candidate, target)
  );
}

async function hasClosableTargetProcess(target?: AntigravityAppTarget | null): Promise<boolean> {
  const processes = await findAntigravityProcesses(target);

  return processes.some((processInfo) => {
    if (processInfo.pid === process.pid) {
      return false;
    }

    const candidate = mapProcessInfoToCandidate(processInfo);
    const commandLine = candidate.commandLine;
    if (
      commandLine.includes('Antigravity Manager') ||
      commandLine.includes('antigravity-manager')
    ) {
      return false;
    }

    return isClosableTargetProcessCandidate(candidate, target);
  });
}

async function findClosableTargetProcesses(
  target?: AntigravityAppTarget | null,
  includeAllProcesses = false,
): Promise<ProcessInfo[]> {
  const processes = await findAntigravityProcesses(target, includeAllProcesses);

  return processes.filter((processInfo) => {
    const candidate = mapProcessInfoToCandidate(processInfo);
    const commandLine = candidate.commandLine;

    if (processInfo.pid === process.pid) {
      return false;
    }
    if (
      commandLine.includes('Antigravity Manager') ||
      commandLine.includes('antigravity-manager')
    ) {
      return false;
    }
    return isClosableTargetProcessCandidate(candidate, target);
  });
}

/**
 * Checks if the Antigravity process is running.
 * Uses find-process package for robust cross-platform process detection.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(target?: AntigravityAppTarget | null): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const isRunning = isAnyWindowsTargetImageRunning(target);
      if (isRunning !== null) {
        return isRunning;
      }
    }

    const currentPid = process.pid;
    const resolvedTarget = resolveAntigravityAppTarget(target);
    const processes = await findAntigravityProcesses(target);

    for (const processInfo of processes) {
      // Skip self
      if (processInfo.pid === currentPid) {
        continue;
      }

      const candidate = mapProcessInfoToCandidate(processInfo);
      const processName = candidate.name.toLowerCase();
      const commandLine = candidate.commandLine.toLowerCase();

      // Skip manager process
      if (
        processName.includes('manager') ||
        commandLine.includes('manager') ||
        commandLine.includes('antigravity-manager')
      ) {
        continue;
      }

      if (isTargetAntigravityProcessCandidate(candidate, target)) {
        logger.debug(
          `Found Antigravity process: PID=${processInfo.pid}, name=${processName}, target=${resolvedTarget}, command=${commandLine.substring(0, 100)}`,
        );
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('Error checking process status with find-process:', error);
    return false;
  }
}

/**
 * Closes the Antigravity process.
 * @param edition The IDE edition to close ('1.x' or '2.0'). Defaults to '1.x'.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function closeAntigravity(target?: AntigravityAppTarget | null): Promise<void> {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const appName = resolvedTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  logger.info(`Closing ${appName}...`);
  const platform = process.platform;

  try {
    // Stage 1: Graceful Shutdown (Platform specific)
    if (platform === 'darwin') {
      // macOS: Use AppleScript to quit gracefully
      try {
        logger.info('Attempting graceful exit via AppleScript...');
        execSync(`osascript -e 'tell application "${appName}" to quit'`, {
          stdio: 'ignore',
          timeout: 3000,
        });
        // Wait for a moment
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        logger.warn('AppleScript exit failed, proceeding to next stage');
      }
    } else if (platform === 'win32') {
      // Windows: Use taskkill /IM (without /F) for graceful close
      const exeName = resolvedTarget === 'ide' ? 'Antigravity IDE.exe' : 'Antigravity.exe';
      try {
        logger.info('Attempting graceful exit via taskkill...');
        execSync(`taskkill /IM "${exeName}" /T`, {
          stdio: 'ignore',
          timeout: 2000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        // Ignore failure, we proceed to force-kill next.
      }
    } else if (platform === 'linux') {
      // Linux: Use wmctrl to gracefully close the application window.
      // This triggers the IDE's internal 'before-quit' event, allowing it
      // to flush its SQLite WAL (state.vscdb) before exiting.
      try {
        logger.info(`Attempting graceful exit via wmctrl for ${appName}...`);
        execSync(`wmctrl -c "${appName}"`, {
          stdio: 'ignore',
          timeout: 2000,
        });
        // Wait to allow IDE enough time to flush state to SQLite
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        logger.warn('wmctrl exit failed or not available, proceeding to next stage');
      }
    }

    if (platform === 'win32' && killWindowsTargetImages(target)) {
      return;
    }

    // Stage 2 & 3: Find and kill remaining processes. The broad all-process scan is expensive
    // on Windows, so keep it as a fallback for custom executable names only.
    let targetProcesses = await findClosableTargetProcesses(target);
    if (targetProcesses.length === 0) {
      targetProcesses = await findClosableTargetProcesses(target, true);
    }

    if (targetProcesses.length === 0) {
      logger.info(`No ${appName} processes found running.`);
      return;
    }

    logger.info(`Found ${targetProcesses.length} remaining ${appName} processes. Sending SIGTERM...`);

    for (const processInfo of targetProcesses) {
      try {
        process.kill(processInfo.pid, 'SIGTERM');
      } catch {
        // Ignore if already dead
      }
    }

    // Wait for graceful shutdown (up to 15 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      let stillAlive = false;
      for (const processInfo of targetProcesses) {
        try {
          // Sending signal 0 checks if process exists without killing it
          process.kill(processInfo.pid, 0);
          stillAlive = true;
          break;
        } catch {
          // Process is dead
        }
      }

      if (!stillAlive) {
        logger.info(`All ${appName} processes closed gracefully.`);
        break;
      }
    }

    // Force kill any remaining processes that didn't exit gracefully
    for (const processInfo of targetProcesses) {
      try {
        process.kill(processInfo.pid, 0); // Check if still alive
        logger.warn(`Process ${processInfo.pid} did not exit gracefully. Force killing...`);
        process.kill(processInfo.pid, 'SIGKILL');
      } catch {
        // Process is already dead
      }
    }
  } catch (error) {
    logger.error('Error closing Antigravity', error);
  }
}

/**
 * Waits for the Antigravity process to exit.
 * @param timeoutMs {number} The timeout in milliseconds.
 * @returns {Promise<void>} A promise that resolves when the process exits.
 */
export async function _waitForProcessExit(
  timeoutMs: number,
  pollInterval = 100,
  target?: AntigravityAppTarget | null,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (process.platform === 'win32') {
      const isRunning = isAnyWindowsTargetImageRunning(target);
      if (isRunning === false) {
        return;
      }
      if (isRunning === true) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        continue;
      }
    }

    if (!(await hasClosableTargetProcess(target))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Antigravity process did not exit within ${timeoutMs}ms`);
}

/**
 * Opens a URI protocol.
 * @param uri {string} The URI to open.
 * @returns {Promise<boolean>} True if the URI was opened successfully, false otherwise.
 */
async function openUri(uri: string): Promise<boolean> {
  const platform = process.platform;
  const wsl = isWsl();

  try {
    if (platform === 'darwin') {
      // macOS: use open command
      await execAsync(`open "${uri}"`);
    } else if (platform === 'win32') {
      // Windows: use start command
      await execAsync(`start "" "${uri}"`);
    } else if (wsl) {
      // WSL: use cmd.exe to open URI
      await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${uri}"`);
    } else {
      // Linux: use xdg-open
      await execAsync(`xdg-open "${uri}"`);
    }
    return true;
  } catch (error) {
    logger.warn(`Failed to open URI: ${getErrorMessage(error)}`);
    return false;
  }
}

async function waitForAntigravityStartup(
  timeoutMs = PROCESS_STARTUP_TIMEOUT_MS,
  pollIntervalMs = PROCESS_STARTUP_POLL_INTERVAL_MS,
  target?: AntigravityAppTarget | null,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isProcessRunning(target)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

function shouldUseLinuxGpuSafeLaunchArgs(): boolean {
  if (process.platform !== 'linux' || isWsl()) {
    return false;
  }

  const enableLinuxGpuRaw = process.env.ANTIGRAVITY_MANAGER_ENABLE_LINUX_GPU?.trim().toLowerCase();
  return enableLinuxGpuRaw !== '1' && enableLinuxGpuRaw !== 'true';
}

function getAntigravityUriProtocol(target: AntigravityAppTarget): string {
  return target === 'ide' ? 'antigravity-ide' : 'antigravity';
}

async function startAntigravityByExecutable(
  executablePath: string,
  target?: AntigravityAppTarget | null,
  configuredArgs: string[] = [],
): Promise<void> {
  const appName = resolveAntigravityAppTarget(target) === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  if (process.platform === 'darwin') {
    const appIndex = executablePath.toLowerCase().indexOf('.app');
    if (appIndex >= 0) {
      const appPath = executablePath.slice(0, appIndex + 4);
      const openArgs = [appPath];
      if (configuredArgs.length > 0) {
        openArgs.push('--args', ...configuredArgs);
      }
      const child = spawn('open', openArgs, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    if (!executablePath) {
      const openArgs = ['-a', appName];
      if (configuredArgs.length > 0) {
        openArgs.push('--args', ...configuredArgs);
      }
      const child = spawn('open', openArgs, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    const child = spawn(executablePath, configuredArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  if (process.platform === 'win32') {
    if (!executablePath) {
      throw new Error(`Unable to locate Antigravity executable path`);
    }
    const child = spawn(executablePath, configuredArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: path.win32.dirname(executablePath),
    });
    child.unref();
    return;
  }

  if (isWsl()) {
    if (!executablePath) {
      throw new Error(`Unable to locate Antigravity executable path`);
    }
    const windowsExecutablePath = executablePath
      .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
      .replace(/\//g, '\\');

    const quotedArgs = configuredArgs.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
    await execAsync(
      `/mnt/c/Windows/System32/cmd.exe /c start "" "${windowsExecutablePath}" ${quotedArgs}`,
    );
    return;
  }

  if (!executablePath) {
    throw new Error(`Unable to locate antigravity executable path`);
  }

  const launchArgs = [
    ...configuredArgs,
    ...(shouldUseLinuxGpuSafeLaunchArgs() ? [...LINUX_GPU_SAFE_LAUNCH_ARGS] : []),
  ];
  if (launchArgs.length > 0) {
    logger.info(`Linux launch with GPU-safe args: ${launchArgs.join(' ')}`);
  }

  const child = spawn(executablePath, launchArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Starts the Antigravity process.
 * @param edition The IDE edition to start ('1.x' or '2.0'). Defaults to '1.x'.
 * @param useUri {boolean} Whether to use the URI protocol to start Antigravity.
 * @returns {Promise<void>} A promise that resolves when the process starts.
 */
export async function startAntigravity(
  target?: AntigravityAppTarget | null,
  useUri = true,
): Promise<void> {
  const resolvedTarget = resolveAntigravityAppTarget(target);
  const appName = resolvedTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  const configuredArgs = getConfiguredAntigravityArgs(resolvedTarget);
  const shouldUseUri = resolvedTarget === 'classic' && useUri && configuredArgs.length === 0;
  logger.info(`Starting ${appName}...`);

  if (await isProcessRunning(target)) {
    logger.info(`${appName} is already running`);
    return;
  }

  if (shouldUseUri) {
    logger.info('Using URI protocol to start...');
    const uri = `${getAntigravityUriProtocol(resolvedTarget)}://oauth-success`;

    if (await openUri(uri)) {
      logger.info(`${appName} URI launch command sent`);

      if (
        await waitForAntigravityStartup(
          PROCESS_STARTUP_TIMEOUT_MS,
          PROCESS_STARTUP_POLL_INTERVAL_MS,
          resolvedTarget,
        )
      ) {
        logger.info(`${appName} process detected after URI launch`);
        return;
      }

      logger.warn(`URI launch did not start ${appName}. Falling back to executable launch.`);
    } else {
      logger.warn('URI launch failed, trying executable path...');
    }
  }

  // Fallback to executable path
  logger.info('Using executable path to start...');
  const executablePath = getAntigravityExecutablePath(target);

  try {
    await startAntigravityByExecutable(executablePath, target, configuredArgs);
    logger.info(`${appName} launch command sent`);

    if (process.platform === 'linux' && !isWsl()) {
      const started = await waitForAntigravityStartup(
        PROCESS_STARTUP_TIMEOUT_MS,
        PROCESS_STARTUP_POLL_INTERVAL_MS,
        target,
      );
      if (!started) {
        logger.warn(
          `${appName} launch command completed, but process startup could not be confirmed on Linux.`,
        );
      }
    }
  } catch (error) {
    logger.error(`Failed to start ${appName} via executable`, error);
    throw error;
  }
}
