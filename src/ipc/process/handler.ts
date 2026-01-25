import { exec, execSync } from 'child_process';
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

  const message = error.message;
  const hasPgrep = message.includes('pgrep -xi Antigravity');
  const code = (error as { code?: number }).code;
  return hasPgrep && code === 1;
}

/**
 * Checks if the Antigravity process is running.
 * Uses find-process package for robust cross-platform process detection.
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(): Promise<boolean> {
  try {
    const platform = process.platform;
    const currentPid = process.pid;

    // Use find-process to search for Antigravity processes
    // 'name' search type matches process name
    let processes: ProcessInfo[] = [];
    try {
      processes = await findProcess('name', 'Antigravity', true);
    } catch (error) {
      if (isPgrepNoMatchError(error)) {
        logger.debug('No Antigravity process found (pgrep returned 1)');
        return false;
      }
      throw error;
    }

    logger.debug(`Found ${processes.length} processes matching 'Antigravity'`);

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
        // macOS: Check for Antigravity.app in path
        if (cmd.includes('antigravity.app')) {
          logger.debug(
            `Found Antigravity process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
          );
          return true;
        }
        // Also check if the process name is exactly 'Antigravity' (main process)
        if (name === 'antigravity' && !isHelperProcess(name, cmd)) {
          logger.debug(`Found Antigravity process: PID=${proc.pid}, name=${name}`);
          return true;
        }
      } else if (platform === 'win32') {
        // Windows: Check for Antigravity.exe
        if (name === 'antigravity.exe' || name === 'antigravity') {
          logger.debug(`Found Antigravity process: PID=${proc.pid}, name=${name}`);
          return true;
        }
      } else {
        // Linux: Check for antigravity in name or path (but not tools)
        if (
          (name.includes('antigravity') || cmd.includes('/antigravity')) &&
          !name.includes('tools')
        ) {
          logger.debug(
            `Found Antigravity process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
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

    // Stage 2 & 3: Find and Kill remaining processes
    // We use a more aggressive approach here but try to avoid killing ourselves
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
            // CIM failed (likely older OS), try WMI
            try {
              output = execSync(psCommand('Get-WmiObject'), {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 10,
              });
            } catch (innerE) {
              // Both failed, throw original or log? Throwing lets the outer catch handle it (returning empty list)
              throw e;
            }
          }
        } else {
          // Unix/Linux/macOS
          output = execSync('ps -A -o pid,comm,args', {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10,
          });
        }

        const processList: { pid: number; name: string; cmd: string }[] = [];

        if (platform === 'win32') {
          // Parse CSV Output
          const lines = output.trim().split(/\r?\n/);
          // First line is headers "ProcessId","Name","CommandLine"
          // We start from index 1
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) {
              continue;
            }

            // Regex to match CSV fields: "val1","val2","val3"
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
      // Exclude this electron app (if named Antigravity Manager or antigravity-manager)
      if (p.cmd.includes('Antigravity Manager') || p.cmd.includes('antigravity-manager')) {
        return false;
      }
      // Match Antigravity (but not manager)
      if (platform === 'win32') {
        return (
          p.cmd.includes('Antigravity.exe') ||
          (p.cmd.includes('antigravity') && !p.cmd.includes('manager'))
        );
      } else {
        // Explicit !manager check for Linux/macOS to be defensive
        return (
          (p.cmd.includes('Antigravity') || p.cmd.includes('antigravity')) &&
          !p.cmd.includes('manager')
        );
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
