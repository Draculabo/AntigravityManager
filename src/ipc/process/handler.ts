import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { getAntigravityExecutablePath, isWsl } from '../../utils/paths';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

/**
 * Checks if the Antigravity process is running.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(): Promise<boolean> {
  try {
    const platform = process.platform;
    let command = '';

    if (platform === 'win32' || isWsl()) {
      // Use tasklist.exe for both Windows and WSL
      // In WSL, use absolute path to be safe
      const cmd = isWsl() ? '/mnt/c/Windows/System32/tasklist.exe' : 'tasklist';
      command = `${cmd} /FI "IMAGENAME eq Antigravity.exe" /NH`;
    } else {
      // macOS and Linux (native)
      command = 'pgrep -x Antigravity';
    }

    logger.debug(`Checking process with command: ${command}`);
    const { stdout } = await execAsync(command, { timeout: 2000 });
    logger.debug(`Process check stdout: ${stdout.trim()}`);

    if (platform === 'win32' || isWsl()) {
      return stdout.includes('Antigravity.exe');
    } else {
      // pgrep returns PIDs if found, empty if not
      return stdout.trim().length > 0;
    }
  } catch (error) {
    logger.error('Error checking process status:', error);
    // pgrep returns exit code 1 if no process found
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
        execSync('taskkill /IM "Antigravity.exe" /T', {
          stdio: 'ignore',
          timeout: 3000,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        logger.warn('Graceful taskkill failed, proceeding to next stage');
      }
    }

    // Stage 2 & 3: Find and Kill remaining processes
    // We use a more aggressive approach here but try to avoid killing ourselves
    const currentPid = process.pid;

    // Helper to list processes
    const getProcesses = (): { pid: number; name: string; cmd: string }[] => {
      try {
        let cmd = '';
        if (platform === 'win32') {
          // Use wmic to get process info
          cmd = 'wmic process get ProcessId,Name,CommandLine /FORMAT:CSV';
        } else {
          // Unix/Linux/macOS
          cmd = 'ps -A -o pid,comm,args';
        }

        const output = execSync(cmd, { encoding: 'utf-8' });
        const lines = output.split('\n');
        const processList = [];

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;

          if (platform === 'win32') {
            // CSV format parsing would be better, but simple check for now
            if (line.includes('Antigravity')) {
              // Extract PID (usually last or second to last in CSV)
              const match = line.match(/(\d+)(?:\s*$)/);
              if (match) {
                processList.push({ pid: parseInt(match[1]), name: 'Antigravity', cmd: line });
              }
            }
          } else {
            const pid = parseInt(parts[0]);
            if (isNaN(pid)) continue;
            const rest = parts.slice(1).join(' ');
            if (rest.includes('Antigravity') || rest.includes('antigravity')) {
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
      // Exclude self
      if (p.pid === currentPid) {
        return false;
      }
      // Exclude this electron app (if named Antigravity Manager)
      if (p.cmd.includes('Antigravity Manager')) {
        return false;
      }
      // Match Antigravity
      if (platform === 'win32') {
        return (
          p.cmd.includes('Antigravity.exe') ||
          (p.cmd.includes('antigravity') && !p.cmd.includes('manager'))
        );
      } else {
        return p.cmd.includes('Antigravity') || p.cmd.includes('antigravity');
      }
    });

    if (targetProcessList.length === 0) {
      logger.info('No Antigravity processes found running.');
      return;
    }

    logger.info(`Found ${targetProcessList.length} remaining Antigravity processes. Killing...`);

    for (const p of targetProcessList) {
      try {
        process.kill(p.pid, 'SIGKILL'); // Force kill as final step
      } catch {
        // Ignore if already dead
      }
    }
  } catch (error) {
    logger.error('Error closing Antigravity', error);
    // Fallback to simple kill if everything fails
    try {
      if (platform === 'win32') {
        execSync('taskkill /F /IM "Antigravity.exe" /T', { stdio: 'ignore' });
      } else {
        execSync('pkill -9 -f Antigravity', { stdio: 'ignore' });
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
export async function _waitForProcessExit(timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!(await isProcessRunning())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Process did not exit within timeout');
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
