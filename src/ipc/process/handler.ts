import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import findProcess, { ProcessInfo } from 'find-process';
import { isNumber } from 'lodash-es';
import {
  getAntigravityExecutablePathForEdition,
  getIdeEditionAppName,
  getIdeEditionUriProtocol,
  isWsl,
} from '../../utils/paths';
import { logger } from '../../utils/logger';
import type { IdeEdition } from '../../types/config';

const execAsync = promisify(exec);
const PROCESS_STARTUP_TIMEOUT_MS = 6000;
const PROCESS_STARTUP_POLL_INTERVAL_MS = 200;
const LINUX_GPU_SAFE_LAUNCH_ARGS = ['--disable-gpu', '--disable-gpu-compositing'] as const;

/**
 * Helper process name patterns to exclude (Electron helper processes)
 */
const HELPER_PATTERNS = [
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

/**
 * Check if a process is a helper/auxiliary process that should be excluded.
 * @param name Process name (lowercase)
 * @param cmd Process command line (lowercase)
 * @returns True if the process is a helper process
 */
function isHelperProcess(name: string, cmd: string): boolean {
  const nameLower = name.toLowerCase();
  const cmdLower = cmd.toLowerCase();

  // Check for --type= argument (Electron helper process indicator)
  if (cmdLower.includes('--type=')) {
    return true;
  }

  // Check for helper patterns in process name
  for (const pattern of HELPER_PATTERNS) {
    if (nameLower.includes(pattern)) {
      return true;
    }
  }

  // Check for crashpad in path
  if (cmdLower.includes('crashpad')) {
    return true;
  }

  return false;
}

function isPgrepNoMatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const hasPgrep = message.includes('pgrep') && message.includes('antigravity');
  const code = (error as { code?: number }).code;
  return hasPgrep && code === 1;
}

/**
 * Checks if the Antigravity process is running.
 * Uses find-process package for robust cross-platform process detection.
 * @param edition The IDE edition to check ('1.x' or '2.0'). Defaults to '1.x' for backward compatibility.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(edition?: IdeEdition): Promise<boolean> {
  try {
    const platform = process.platform;
    const currentPid = process.pid;
    const targetEdition = edition ?? '1.x';

    const appName = targetEdition === '2.0' ? 'Antigravity IDE' : 'Antigravity';
    const appNameLower = appName.toLowerCase();

    // Use find-process to search for Antigravity processes
    const allMatches: ProcessInfo[] = [];
    const searchNames = [appName, appNameLower];
    if (platform === 'linux') {
      searchNames.push('electron');
    }
    let sawNoMatch = false;

    for (const searchName of searchNames) {
      try {
        const matches = await findProcess('name', searchName, false);
        allMatches.push(...matches);
      } catch (error) {
        if (isPgrepNoMatchError(error)) {
          sawNoMatch = true;
          continue;
        }
        throw error;
      }
    }

    const processMap = new Map<number, ProcessInfo>();
    for (const proc of allMatches) {
      if (isNumber(proc.pid)) {
        processMap.set(proc.pid, proc);
      }
    }

    const processes = Array.from(processMap.values());
    if (processes.length === 0 && sawNoMatch) {
      logger.debug(`No ${appName} process found (pgrep returned 1)`);
    }

    logger.debug(`Found ${processes.length} processes matching '${appName}'`);

    for (const proc of processes) {
      // Skip self
      if (proc.pid === currentPid) {
        continue;
      }

      const name = proc.name?.toLowerCase() || '';
      const cmd = proc.cmd?.toLowerCase() || '';

      // Skip manager process
      if (
        name.includes('manager') ||
        cmd.includes('manager') ||
        cmd.includes('antigravity-manager')
      ) {
        continue;
      }

      // Skip helper processes
      if (isHelperProcess(name, cmd)) {
        continue;
      }

      if (platform === 'darwin') {
        const appBundle = targetEdition === '2.0' ? 'antigravity ide.app' : 'antigravity.app';
        if (cmd.includes(appBundle)) {
          logger.debug(
            `Found ${appName} process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
          );
          return true;
        }
        if (name === appNameLower && !isHelperProcess(name, cmd)) {
          logger.debug(`Found ${appName} process: PID=${proc.pid}, name=${name}`);
          return true;
        }
      } else if (platform === 'win32') {
        const exeName = targetEdition === '2.0' ? 'antigravity ide.exe' : 'antigravity.exe';
        if (name === exeName || name === appNameLower) {
          logger.debug(`Found ${appName} process: PID=${proc.pid}, name=${name}`);
          return true;
        }
      } else {
        const nameLower = name.toLowerCase();
        const cmdLower = cmd.toLowerCase();

        if (nameLower === 'electron') {
          const isAntigravityApp =
            (cmdLower.includes(`/${appNameLower}`) ||
              cmdLower.includes(` ${appNameLower}`) ||
              cmdLower.endsWith(appNameLower)) &&
            !cmdLower.includes('manager') &&
            !cmdLower.includes('tools');

          if (isAntigravityApp) {
            logger.debug(
              `Found ${appName} (AUR/electron) process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
            );
            return true;
          }
        }

        if (
          (name.includes(appNameLower) || cmd.includes(`/${appNameLower}`)) &&
          !name.includes('tools')
        ) {
          logger.debug(
            `Found ${appName} process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
          );
          return true;
        }
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
export async function closeAntigravity(edition?: IdeEdition): Promise<void> {
  const targetEdition = edition ?? '1.x';
  const appName = getIdeEditionAppName(targetEdition);
  const exeName = targetEdition === '2.0' ? 'Antigravity IDE.exe' : 'Antigravity.exe';

  logger.info(`Closing ${appName}...`);
  const platform = process.platform;

  try {
    // Stage 1: Graceful Shutdown (Platform specific)
    if (platform === 'darwin') {
      // macOS: Use AppleScript to quit gracefully
      try {
        logger.info(`Attempting graceful exit via AppleScript for ${appName}...`);
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
      try {
        logger.info('Attempting graceful exit via taskkill...');
        execSync(`taskkill /IM "${exeName}" /T`, {
          stdio: 'ignore',
          timeout: 2000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        // Ignore failure, we play hard next.
      }
    }

    // Stage 2 & 3: Find and Kill remaining processes
    const currentPid = process.pid;

    // Helper to list processes
    const getProcesses = (): { pid: number; name: string; cmd: string }[] => {
      try {
        let output = '';
        if (platform === 'win32') {
          const psCommand = (cmdlet: string) =>
            `powershell -NoProfile -Command "${cmdlet} Win32_Process -Filter \\"Name like 'Antigravity%'\\" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Csv -NoTypeInformation"`;

          try {
            output = execSync(psCommand('Get-CimInstance'), {
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024 * 10,
              stdio: ['pipe', 'pipe', 'ignore'],
            });
          } catch (e) {
            try {
              output = execSync(psCommand('Get-WmiObject'), {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 10,
              });
            } catch (innerE) {
              throw e;
            }
          }
        } else {
          output = execSync('ps -A -o pid,comm,args', {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10,
          });
        }

        const processList: { pid: number; name: string; cmd: string }[] = [];

        if (platform === 'win32') {
          const lines = output.trim().split(/\r?\n/);
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) {
              continue;
            }

            const match = line.match(/^"(\d+)","(.*?)","(.*?)"$/);

            if (match) {
              const pid = parseInt(match[1]);
              const name = match[2];
              const cmdLine = match[3];

              processList.push({ pid, name, cmd: cmdLine || name });
            }
          }
        } else {
          const lines = output.split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2) continue;

            const pid = parseInt(parts[0]);
            if (isNaN(pid)) continue;
            const rest = parts.slice(1).join(' ');
            if (rest.includes(appName) || rest.includes(appName.toLowerCase())) {
              processList.push({ pid, name: parts[1], cmd: rest });
            }
          }
        }
        return processList;
      } catch (e) {
        logger.error('Failed to list processes', e);
        return [];
      }
    };

    const targetProcessList = getProcesses().filter((p) => {
      if (p.pid === currentPid) {
        return false;
      }
      if (p.cmd.includes('Antigravity Manager') || p.cmd.includes('antigravity-manager')) {
        return false;
      }
      if (platform === 'win32') {
        return (
          p.cmd.includes(exeName) ||
          (p.cmd.includes(appName.toLowerCase()) && !p.cmd.includes('manager'))
        );
      } else {
        return (
          (p.cmd.includes(appName) || p.cmd.includes(appName.toLowerCase())) &&
          !p.cmd.includes('manager')
        );
      }
    });

    if (targetProcessList.length === 0) {
      logger.info(`No ${appName} processes found running.`);
      return;
    }

    logger.info(`Found ${targetProcessList.length} remaining ${appName} processes. Killing...`);

    for (const p of targetProcessList) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // Ignore if already dead
      }
    }
  } catch (error) {
    logger.error(`Error closing ${appName}`, error);
    try {
      if (platform === 'win32') {
        execSync(`taskkill /F /IM "${exeName}" /T`, { stdio: 'ignore' });
      } else {
        execSync(`pkill -9 -f "${appName}"`, { stdio: 'ignore' });
      }
    } catch {
      // Ignore
    }
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
  edition?: IdeEdition,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!(await isProcessRunning(edition))) {
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
    logger.error('Failed to open URI', error);
    return false;
  }
}

async function waitForAntigravityStartup(
  timeoutMs = PROCESS_STARTUP_TIMEOUT_MS,
  pollIntervalMs = PROCESS_STARTUP_POLL_INTERVAL_MS,
  edition?: IdeEdition,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isProcessRunning(edition)) {
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

async function startAntigravityByExecutable(
  execPath: string,
  edition: IdeEdition,
): Promise<void> {
  if (process.platform === 'darwin') {
    const appName = getIdeEditionAppName(edition);
    await execAsync(`open -a "${appName}"`);
    return;
  }

  if (process.platform === 'win32') {
    if (!execPath) {
      throw new Error(`Unable to locate ${getIdeEditionAppName(edition)} executable path`);
    }
    await execAsync(`start "" "${execPath}"`);
    return;
  }

  if (isWsl()) {
    if (!execPath) {
      throw new Error(`Unable to locate ${getIdeEditionAppName(edition)} executable path`);
    }
    const winPath = execPath
      .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
      .replace(/\//g, '\\');

    await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${winPath}"`);
    return;
  }

  if (!execPath) {
    throw new Error(`Unable to locate ${getIdeEditionAppName(edition)} executable path`);
  }

  const launchArgs = shouldUseLinuxGpuSafeLaunchArgs() ? [...LINUX_GPU_SAFE_LAUNCH_ARGS] : [];
  if (launchArgs.length > 0) {
    logger.info(`Linux launch with GPU-safe args: ${launchArgs.join(' ')}`);
  }

  const child = spawn(execPath, launchArgs, {
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
export async function startAntigravity(edition?: IdeEdition, useUri = true): Promise<void> {
  const targetEdition = edition ?? '1.x';
  const appName = getIdeEditionAppName(targetEdition);

  logger.info(`Starting ${appName}...`);

  if (await isProcessRunning(targetEdition)) {
    logger.info(`${appName} is already running`);
    return;
  }

  if (useUri) {
    logger.info('Using URI protocol to start...');
    const uriProtocol = getIdeEditionUriProtocol(targetEdition);
    const uri = `${uriProtocol}://oauth-success`;

    if (await openUri(uri)) {
      logger.info(`${appName} URI launch command sent`);

      if (process.platform !== 'linux' || isWsl()) {
        return;
      }

      if (await waitForAntigravityStartup(undefined, undefined, targetEdition)) {
        logger.info(`${appName} process detected after URI launch`);
        return;
      }

      logger.warn(
        `URI launch did not keep ${appName} running on Linux. Falling back to executable launch.`,
      );
    } else {
      logger.warn('URI launch failed, trying executable path...');
    }
  }

  // Fallback to executable path
  logger.info('Using executable path to start...');
  const execPath = getAntigravityExecutablePathForEdition(targetEdition);

  try {
    await startAntigravityByExecutable(execPath, targetEdition);
    logger.info(`${appName} launch command sent`);

    if (process.platform === 'linux' && !isWsl()) {
      const started = await waitForAntigravityStartup(undefined, undefined, targetEdition);
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
