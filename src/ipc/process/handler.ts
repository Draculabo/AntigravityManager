import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import findProcess, { ProcessInfo } from 'find-process';
import { getAntigravityExecutablePath, isWsl } from '../../utils/paths';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

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

function isAntigravityMainProcess(proc: ProcessInfo, platform: NodeJS.Platform): boolean {
  const currentPid = process.pid;
  if (proc.pid === currentPid) {
    return false;
  }

  const name = proc.name?.toLowerCase() || '';
  const cmd = proc.cmd?.toLowerCase() || '';

  if (
    name.includes('manager') ||
    cmd.includes('manager') ||
    cmd.includes('antigravity-manager')
  ) {
    return false;
  }

  if (isHelperProcess(name, cmd)) {
    return false;
  }

  if (platform === 'darwin') {
    if (cmd.includes('antigravity.app')) {
      return true;
    }
    return name === 'antigravity' && !isHelperProcess(name, cmd);
  }

  if (platform === 'win32') {
    return name === 'antigravity.exe' || name === 'antigravity';
  }

  return (
    (name.includes('antigravity') || cmd.includes('/antigravity')) &&
    !name.includes('tools')
  );
}

async function getAntigravityProcessPids(): Promise<number[]> {
  const platform = process.platform;
  const processMap = new Map<number, ProcessInfo>();
  const searchNames = ['Antigravity', 'antigravity'];

  for (const searchName of searchNames) {
    try {
      const matches = await findProcess('name', searchName, true);
      for (const proc of matches) {
        if (typeof proc.pid === 'number') {
          processMap.set(proc.pid, proc);
        }
      }
    } catch (error) {
      if (isPgrepNoMatchError(error)) {
        continue;
      }
      throw error;
    }
  }

  return Array.from(processMap.values())
    .filter((proc) => isAntigravityMainProcess(proc, platform))
    .map((proc) => proc.pid as number);
}

async function getAntigravityProcessPidsMatchingPath(managedPath: string): Promise<number[]> {
  const platform = process.platform;
  const processMap = new Map<number, ProcessInfo>();
  const searchNames = ['Antigravity', 'antigravity'];

  for (const searchName of searchNames) {
    try {
      const matches = await findProcess('name', searchName, true);
      for (const proc of matches) {
        if (typeof proc.pid === 'number') {
          processMap.set(proc.pid, proc);
        }
      }
    } catch (error) {
      if (isPgrepNoMatchError(error)) {
        continue;
      }
      throw error;
    }
  }

  return Array.from(processMap.values())
    .filter((proc) => isAntigravityMainProcess(proc, platform))
    .filter((proc) => (proc.cmd ?? '').includes(managedPath))
    .map((proc) => proc.pid as number);
}

export async function isProcessRunning(): Promise<boolean> {
  try {
    const pids = await getAntigravityProcessPids();
    return pids.length > 0;
  } catch (error) {
    logger.error('Error checking process status with find-process:', error);
    return false;
  }
}

/**
 * Closes the Antigravity process.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function closeAntigravity(): Promise<void> {
  logger.info('Closing Antigravity...');
  const platform = process.platform;

  try {
    // Stage 1: Graceful Shutdown (Platform specific)
    if (platform === 'darwin') {
      // macOS: Use AppleScript to quit gracefully
      try {
        logger.info('Attempting graceful exit via AppleScript...');
        execSync('osascript -e \'tell application "Antigravity" to quit\'', {
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
        // /T = Tree (child processes), /IM = Image Name
        // We do not wait long here.
        execSync('taskkill /IM "Antigravity.exe" /T', {
          stdio: 'ignore',
          timeout: 2000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        // Ignore failure, we play hard next.
      }
    }

    const managedPath = getAntigravityExecutablePath();

    if (platform === 'win32') {
      if (!managedPath) {
        logger.info('Antigravity executable path not found, skipping process kill');
        return;
      }
      try {
        execSync('taskkill /F /IM "Antigravity.exe" /T', { stdio: 'ignore' });
      } catch (fallbackError) {
        logger.debug('taskkill failed (process may already be gone)', fallbackError);
      }
      return;
    }

    if (platform === 'linux' || platform === 'darwin') {
      const killByPids = async (pids: number[]) => {
        if (pids.length === 0) return;
        if (platform === 'linux') {
          try {
            process.kill(-pids[0], 'SIGKILL');
          } catch {
            for (const pid of pids) {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                logger.debug(`kill -9 ${pid} failed (process may already be gone)`);
              }
            }
          }
        } else {
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              logger.debug(`kill -9 ${pid} failed (process may already be gone)`);
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      };

      if (platform === 'linux') {
        if (managedPath) {
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              execSync(`pkill -9 -f "${managedPath}"`, { stdio: 'ignore' });
            } catch {
              logger.debug('pkill returned non-zero (process may already be gone)');
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (!(await isProcessRunning())) break;
          }
        }

        if (await isProcessRunning()) {
          const pidsByPath = managedPath ? await getAntigravityProcessPidsMatchingPath(managedPath) : [];
          const pidsAll = await getAntigravityProcessPids();
          const pids = pidsByPath.length > 0 ? pidsByPath : pidsAll;
          if (pids.length > 0) {
            logger.info(`Killing Antigravity PIDs: ${pids.join(', ')}`);
            await killByPids(pids);
          }
        }

        const maxWait = 5;
        for (let w = 0; w < maxWait && (await isProcessRunning()); w++) {
          const pids = await getAntigravityProcessPids();
          if (pids.length > 0) {
            await killByPids(pids);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } else if (managedPath) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            execSync(`pkill -9 -f "${managedPath}"`, { stdio: 'ignore' });
          } catch {
            logger.debug('pkill returned non-zero (process may already be gone)');
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (!(await isProcessRunning())) break;
          if (attempt < maxRetries) {
            logger.debug(`Antigravity processes still running, retry ${attempt + 1}/${maxRetries}`);
          }
        }

        if (managedPath && (await isProcessRunning())) {
          const pids = await getAntigravityProcessPidsMatchingPath(managedPath);
          if (pids.length > 0) {
            logger.info(`pkill did not terminate process, falling back to PID-based kill (PIDs: ${pids.join(', ')})`);
            await killByPids(pids);
          }
        }
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
  pollInterval = 100, // Make it configurable, but keep fast 100ms default
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!(await isProcessRunning())) {
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
      const child = spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return true;
  } catch (error) {
    logger.error('Failed to open URI', error);
    return false;
  }
}

/**
 * Starts the Antigravity process.
 * @param useUri {boolean} Whether to use the URI protocol to start Antigravity.
 * @returns {Promise<void>} A promise that resolves when the process starts.
 */
export async function startAntigravity(useUri = true): Promise<void> {
  logger.info('Starting Antigravity...');

  if (await isProcessRunning()) {
    logger.info('Antigravity is already running');
    return;
  }

  if (useUri) {
    logger.info('Using URI protocol to start...');
    const uri = 'antigravity://oauth-success';

    if (await openUri(uri)) {
      logger.info('Antigravity URI launch command sent');
      return;
    } else {
      logger.warn('URI launch failed, trying executable path...');
    }
  }

  // Fallback to executable path
  logger.info('Using executable path to start...');
  const execPath = getAntigravityExecutablePath();

  try {
    if (process.platform === 'darwin') {
      await execAsync(`open -a Antigravity`);
    } else if (process.platform === 'win32') {
      // Use start command to detach
      await execAsync(`start "" "${execPath}"`);
    } else if (isWsl()) {
      // In WSL, convert path and use cmd.exe
      const winPath = execPath
        .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
        .replace(/\//g, '\\');

      await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${winPath}"`);
    } else {
      // Linux native
      const child = exec(`"${execPath}"`);
      child.unref();
    }
    logger.info('Antigravity launch command sent');
  } catch (error) {
    logger.error('Failed to start Antigravity via executable', error);
    throw error;
  }
}
