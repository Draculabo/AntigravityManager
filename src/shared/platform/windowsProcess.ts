import { execSync } from 'child_process';
import path from 'path';
import findProcess from 'find-process';
import psList from 'ps-list';

const WINDOWS_PROCESS_COMMAND_TIMEOUT_MS = 3000;
const runningImageQueries = new Map<string, Promise<boolean | null>>();

export interface WindowsProcessInfo {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

export function isSafeWindowsImageName(imageName: string): boolean {
  return /^[^"'&|<>]+\.exe$/i.test(imageName);
}

async function queryWindowsImageRunning(imageName: string): Promise<boolean | null> {
  try {
    const normalizedImageName = imageName.toLowerCase();
    if (process.arch === 'arm64') {
      const processes = await findProcess('name', imageName, { strict: true });
      return processes.some(
        (processInfo) => processInfo.name.toLowerCase() === normalizedImageName,
      );
    }

    const processes = await psList();
    return processes.some((processInfo) => processInfo.name.toLowerCase() === normalizedImageName);
  } catch {
    return null;
  }
}

/**
 * Keep status polling off Electron's main event loop and reuse an in-flight query when rapid UI
 * mounts request the same image before the native process scan has returned.
 */
export function isWindowsImageRunning(imageName: string): Promise<boolean | null> {
  const queryKey = imageName.toLowerCase();
  const activeQuery = runningImageQueries.get(queryKey);
  if (activeQuery) {
    return activeQuery;
  }

  const query = queryWindowsImageRunning(imageName).finally(() => {
    runningImageQueries.delete(queryKey);
  });
  runningImageQueries.set(queryKey, query);
  return query;
}

export async function killWindowsImageTree(imageName: string): Promise<boolean> {
  try {
    execSync(`taskkill /F /T /IM "${imageName}"`, {
      stdio: 'ignore',
      timeout: WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
    });
    return true;
  } catch {
    return (await isWindowsImageRunning(imageName)) === false;
  }
}

function parseCommandExecutableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"')) {
    const closingQuoteIndex = trimmed.indexOf('"', 1);
    if (closingQuoteIndex > 1) {
      return path.win32.basename(trimmed.slice(1, closingQuoteIndex));
    }
  }

  const firstSpaceIndex = trimmed.search(/\s/);
  return path.win32.basename(firstSpaceIndex >= 0 ? trimmed.slice(0, firstSpaceIndex) : trimmed);
}

export function parseWmicProcessList(output: string): WindowsProcessInfo[] {
  const processes: WindowsProcessInfo[] = [];
  let commandLine = '';
  let executablePath = '';

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (key === 'CommandLine') {
      commandLine = value;
      continue;
    }
    if (key === 'ExecutablePath') {
      executablePath = value;
      continue;
    }
    if (key === 'ProcessId') {
      const pid = Number(value);
      if (Number.isFinite(pid) && pid > 0) {
        processes.push({
          pid,
          name: path.win32.basename(executablePath || parseCommandExecutableName(commandLine)),
          executablePath,
          commandLine,
        });
      }
      commandLine = '';
      executablePath = '';
    }
  }

  return processes;
}

export function queryWindowsProcessesByImageName(imageName: string): WindowsProcessInfo[] | null {
  try {
    const output = execSync(
      `wmic process where "name='${imageName}'" get ProcessId,ExecutablePath,CommandLine /format:list`,
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: WINDOWS_PROCESS_COMMAND_TIMEOUT_MS,
      },
    );
    return parseWmicProcessList(output);
  } catch {
    return null;
  }
}
