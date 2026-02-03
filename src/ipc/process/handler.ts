import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import findProcess, { ProcessInfo } from 'find-process';
import { getAntigravityExecutablePath, isWsl } from '../../utils/paths';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

/**
 * Process name patterns for matching Antigravity processes.
 * Using regex with word boundaries for more precise matching.
 */
const PROCESS_PATTERNS = {
  // Patterns to identify Manager processes (should be excluded)
  manager: {
    exact: /\bantigravity[-\s]?manager\b/i,
    nameContains: /\bmanager\b/i,
  },
  // Patterns to identify main Antigravity app
  antigravity: {
    macApp: /\bantigravity\.app\b/i,
    winExe: /\bantigravity\.exe\b/i,
    exactName: /^antigravity$/i,
    pathBased: /[/\\]antigravity\b/i,
  },
  // Patterns to exclude (development/helper processes)
  exclude: {
    electronForge: /\belectron-forge\b/i,
    nodeModules: /\bnode_modules[/\\]electron\b/i,
    managerWorkspace: /\bAntigravityManager\b/,
    tools: /\bantigravity[-\s]?tools\b/i,
  },
} as const;

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
 * Check if a process is a Manager process that should be excluded.
 * @param name Process name
 * @param cmd Process command line
 * @returns True if the process is a Manager process
 */
function isManagerProcess(name: string, cmd: string): boolean {
  return (
    PROCESS_PATTERNS.manager.exact.test(cmd) ||
    PROCESS_PATTERNS.manager.exact.test(name) ||
    PROCESS_PATTERNS.manager.nameContains.test(name)
  );
}

/**
 * Check if a process is the main Antigravity app.
 * @param name Process name
 * @param cmd Process command line
 * @param platform Current platform
 * @returns True if the process is the main Antigravity app
 */
function isAntigravityApp(name: string, cmd: string, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') {
    return (
      PROCESS_PATTERNS.antigravity.macApp.test(cmd) ||
      PROCESS_PATTERNS.antigravity.exactName.test(name)
    );
  } else if (platform === 'win32') {
    return (
      PROCESS_PATTERNS.antigravity.winExe.test(name) ||
      PROCESS_PATTERNS.antigravity.exactName.test(name)
    );
  } else {
    // Linux
    return (
      PROCESS_PATTERNS.antigravity.exactName.test(name) ||
      PROCESS_PATTERNS.antigravity.pathBased.test(cmd)
    );
  }
}

/**
 * Check if a process should be excluded (development/workspace processes).
 * @param cmd Process command line
 * @returns True if the process should be excluded
 */
function isExcludedProcess(cmd: string): boolean {
  return (
    PROCESS_PATTERNS.exclude.electronForge.test(cmd) ||
    PROCESS_PATTERNS.exclude.nodeModules.test(cmd) ||
    PROCESS_PATTERNS.exclude.managerWorkspace.test(cmd) ||
    PROCESS_PATTERNS.exclude.tools.test(cmd)
  );
}

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
    // 'name' search type matches process name
    const processMap = new Map<number, ProcessInfo>();
    const searchNames = ['Antigravity', 'antigravity'];
    let sawNoMatch = false;

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
          sawNoMatch = true;
          continue;
        }
        throw error;
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

      const name = proc.name || '';
      const cmd = proc.cmd || '';

      // Skip manager process using strict pattern matching
      if (isManagerProcess(name, cmd)) {
        continue;
      }

      // Skip helper processes
      if (isHelperProcess(name, cmd)) {
        continue;
      }

      // Skip excluded processes (development mode, etc.)
      if (isExcludedProcess(cmd)) {
        continue;
      }

      // Check if this is the main Antigravity app using strict pattern matching
      if (isAntigravityApp(name, cmd, platform)) {
        logger.debug(
          `Found Antigravity process: PID=${proc.pid}, name=${name}, cmd=${cmd.substring(0, 100)}`,
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

      // Exclude Manager processes using strict pattern matching
      if (isManagerProcess(p.name, p.cmd)) {
        return false;
      }

      // Exclude development mode and helper processes
      if (isExcludedProcess(p.cmd)) {
        return false;
      }

      // Match main Antigravity app using strict pattern matching
      return isAntigravityApp(p.name, p.cmd, platform);
    });

    if (targetProcessList.length === 0) {
      logger.info('No Antigravity processes found running.');
      return;
    }

    logger.info(`Found ${targetProcessList.length} remaining Antigravity processes. Killing...`);

    for (const p of targetProcessList) {
      try {
        process.kill(p.pid, 'SIGKILL'); // Force kill as final step
      } catch (killError) {
        // Log but continue - process may already be dead
        logger.debug(`Failed to kill process ${p.pid}: ${killError}`);
      }
    }
  } catch (error) {
    logger.error('Error closing Antigravity', error);

    // Fallback to simple kill if everything fails
    // Use dynamic executable path where possible
    try {
      const execPath = getAntigravityExecutablePath();
      logger.warn('Attempting fallback termination...');

      if (platform === 'win32') {
        // Extract executable name from path for taskkill
        const exeName = execPath.split(/[/\\]/).pop() || 'Antigravity.exe';
        const cmd = `taskkill /F /IM "${exeName}" /T`;
        logger.debug(`Fallback command (Windows): ${cmd}`);
        execSync(cmd, { stdio: 'ignore' });
      } else if (platform === 'darwin') {
        // For macOS, use the app bundle path pattern
        // Try to extract app name from executable path
        const appMatch = execPath.match(/([^/]+\.app)/i);
        const appName = appMatch ? appMatch[1] : 'Antigravity.app';
        const cmd = `pkill -9 -f "${appName}/Contents/MacOS"`;
        logger.debug(`Fallback command (macOS): ${cmd}`);
        execSync(cmd, { stdio: 'ignore' });
      } else {
        // Linux: Use the executable path directly
        const cmd = `pkill -9 -f "${execPath}"`;
        logger.debug(`Fallback command (Linux): ${cmd}`);
        execSync(cmd, { stdio: 'ignore' });
      }

      logger.info('Fallback termination command executed');
    } catch (fallbackError) {
      // Log the fallback error for troubleshooting
      logger.warn('Fallback termination failed', fallbackError);
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
