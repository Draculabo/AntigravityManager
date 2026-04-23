import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import findProcess, { ProcessInfo } from 'find-process';
import { isNumber } from 'lodash-es';
import { getAntigravityExecutablePath, isWsl } from '../../utils/paths';
import { logger } from '../../utils/logger';

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
 * @returns {boolean} True if the Antigravity process is running, false otherwise.
 */
export async function isProcessRunning(): Promise<boolean> {
  try {
    const platform = process.platform;
    const currentPid = process.pid;

    // Use find-process to search for Antigravity processes
    const allMatches: ProcessInfo[] = [];
    const searchNames = ['Antigravity', 'antigravity'];
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
      logger.debug('No Antigravity process found (pgrep returned 1)');
    }

    logger.debug(`Found ${processes.length} processes matching 'Antigravity/antigravity'`);

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
        const nameLower = name.toLowerCase();
        const cmdLower = cmd.toLowerCase();

        if (nameLower === 'electron') {
          // Stricter check for AUR/Electron wrapper:
          // Must include antigravity in command line but NOT manager or tools
          const isAntigravityApp =
            (cmdLower.includes('/antigravity') ||
              cmdLower.includes(' antigravity') ||
              cmdLower.endsWith('antigravity')) &&
            !cmdLower.includes('manager') &&
            !cmdLower.includes('tools');

          if (isAntigravityApp) {
            logger.debug(
              `Found Antigravity (AUR/electron) process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
            );
            return true;
          }
        }

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

    // Stage 2 & 3: Find and Kill remaining processes.
    // We use a more aggressive approach here, but carefully avoid killing
    // the Electron manager process itself or unrelated processes.
    const currentPid = process.pid;

    /**
     * Known Linux/macOS install path prefixes for the Antigravity binary.
     * Only processes whose command line starts with one of these paths are
     * considered safe to kill. This prevents accidentally killing the
     * AntigravityManager Electron app or Antigravity extension helpers.
     */
    const ANTIGRAVITY_INSTALL_PATH_PREFIXES = [
      '/opt/Antigravity/',
      '/opt/antigravity/',
      '/usr/share/antigravity/',
      '/usr/local/bin/antigravity',
      '/usr/bin/antigravity',
      // macOS .app bundle paths (capitalized and lowercase variants)
      '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      '/Applications/antigravity.app/Contents/MacOS/antigravity',
    ];

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
              // Both failed; let outer catch handle it (returns empty list)
              throw e;
            }
          }
        } else {
          // Unix/Linux/macOS — use pid,args (no comm) so the first token
          // after the PID is the real executable path, enabling the
          // install-path startsWith check to work correctly.
          output = execSync('ps -A -o pid,args', {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10,
          });
        }

        const processList: { pid: number; name: string; cmd: string }[] = [];

        if (platform === 'win32') {
          // Parse CSV output: first line is headers, data starts at index 1
          const lines = output.trim().split(/\r?\n/);
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) {
              continue;
            }

            // Match CSV fields: "val1","val2","val3"
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
            if (parts.length < 2) {
              continue;
            }

            const pid = parseInt(parts[0]);
            if (isNaN(pid)) {
              continue;
            }

            const cmd = parts.slice(1).join(' ');

            // Only include processes running from a known Antigravity install
            // path. Because we use `pid,args` (no comm column), parts[1] is
            // the real executable path, so startsWith is reliable here.
            const isFromInstallPath = ANTIGRAVITY_INSTALL_PATH_PREFIXES.some((prefix) =>
              cmd.startsWith(prefix),
            );
            if (isFromInstallPath) {
              processList.push({ pid, name: parts[1] ?? '', cmd });
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
      // Exclude the manager app under all naming variants (defensive)
      if (
        p.cmd.includes('AntigravityManager') ||
        p.cmd.includes('Antigravity Manager') ||
        p.cmd.includes('antigravity-manager')
      ) {
        return false;
      }
      // Windows: match by executable name
      if (platform === 'win32') {
        return (
          p.cmd.includes('Antigravity.exe') ||
          (p.cmd.includes('antigravity') && !p.cmd.includes('manager'))
        );
      }
      // Linux/macOS: already filtered to install-path processes above
      return true;
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
    // Fallback: kill only the known Antigravity binary, never a broad pattern
    // that could match the manager app itself.
    try {
      if (platform === 'win32') {
        execSync('taskkill /F /IM "Antigravity.exe" /T', { stdio: 'ignore' });
      } else {
        // Use -x to match the exact executable name, not substrings.
        // Run both casings because macOS installs as 'Antigravity' (capital A)
        // while Linux installs use 'antigravity' (lowercase).
        // Errors are swallowed intentionally — process may already be gone or
        // the variant may not exist on this platform.
        try {
          execSync('pkill -9 -x antigravity', { stdio: 'ignore' });
        } catch {
          // Ignore — may not match on this system
        }
        execSync('pkill -9 -x Antigravity', { stdio: 'ignore' });
      }
    } catch {
      // Ignore — process may already be gone
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
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isProcessRunning()) {
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

async function startAntigravityByExecutable(execPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execAsync(`open -a Antigravity`);
    return;
  }

  if (process.platform === 'win32') {
    if (!execPath) {
      throw new Error('Unable to locate Antigravity executable path');
    }
    // Use start command to detach
    await execAsync(`start "" "${execPath}"`);
    return;
  }

  if (isWsl()) {
    if (!execPath) {
      throw new Error('Unable to locate Antigravity executable path');
    }
    // In WSL, convert path and use cmd.exe
    const winPath = execPath
      .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
      .replace(/\//g, '\\');

    await execAsync(`/mnt/c/Windows/System32/cmd.exe /c start "" "${winPath}"`);
    return;
  }

  if (!execPath) {
    throw new Error('Unable to locate Antigravity executable path');
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

      if (process.platform !== 'linux' || isWsl()) {
        return;
      }

      if (await waitForAntigravityStartup()) {
        logger.info('Antigravity process detected after URI launch');
        return;
      }

      logger.warn(
        'URI launch did not keep Antigravity running on Linux. Falling back to executable launch.',
      );
    } else {
      logger.warn('URI launch failed, trying executable path...');
    }
  }

  // Fallback to executable path
  logger.info('Using executable path to start...');
  const execPath = getAntigravityExecutablePath();

  try {
    await startAntigravityByExecutable(execPath);
    logger.info('Antigravity launch command sent');

    if (process.platform === 'linux' && !isWsl()) {
      const started = await waitForAntigravityStartup();
      if (!started) {
        logger.warn(
          'Antigravity launch command completed, but process startup could not be confirmed on Linux.',
        );
      }
    }
  } catch (error) {
    logger.error('Failed to start Antigravity via executable', error);
    throw error;
  }
}
