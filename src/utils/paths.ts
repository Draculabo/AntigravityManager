import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

/**
 * Checks if the current platform is WSL.
 * @returns {boolean} True if the current platform is WSL, false otherwise.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return version.includes('microsoft') && version.includes('wsl');
  } catch {
    return false;
  }
}

let cachedWindowsUser: string | null = null;

/**
 * Gets the Windows username.
 * @returns {string} The Windows username.
 */
function getWindowsUser(): string {
  if (cachedWindowsUser) return cachedWindowsUser;

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
          fs.statSync(path.join('/mnt/c/Users', u)).isDirectory(),
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

export function getAppDataDir(): string {
  const home = os.homedir();

  if (isWsl()) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Roaming/Antigravity`;
  }

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Antigravity');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity');
    case 'linux':
      return path.join(home, '.config', 'Antigravity');
    default:
      return path.join(home, '.antigravity');
  }
}

export function getAgentDir(): string {
  return path.join(os.homedir(), '.antigravity-agent');
}

export function getAccountsFilePath(): string {
  return path.join(getAgentDir(), 'antigravity_accounts.json');
}

export function getBackupsDir(): string {
  return path.join(getAgentDir(), 'backups');
}

export function getCloudAccountsDbPath(): string {
  return path.join(getAgentDir(), 'cloud_accounts.db');
}

export function getAntigravityDbPaths(): string[] {
  const appData = getAppDataDir();
  const paths: string[] = [];
  const home = os.homedir();

  if (isWsl()) {
    // Assume standard structure: AppData/Roaming/Antigravity/User/globalStorage/state.vscdb
    // appData is already resolved to Roaming/Antigravity in getAppDataDir()
    paths.push(path.join(appData, 'User', 'globalStorage', 'state.vscdb'));
    paths.push(path.join(appData, 'User', 'state.vscdb'));
    paths.push(path.join(appData, 'state.vscdb'));
    return paths;
  }

  if (process.platform === 'linux') {
    paths.push(path.join(appData, 'User', 'globalStorage', 'state.vscdb'));
    paths.push(path.join(appData, 'User', 'state.vscdb'));
    paths.push(path.join(appData, 'state.vscdb'));
    return paths;
  }

  if (process.platform === 'darwin') {
    // Standard path
    paths.push(
      path.join(
        home,
        'Library',
        'Application Support',
        'Antigravity',
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    );
    // Fallback path
    paths.push(path.join(home, 'Library', 'Application Support', 'Antigravity', 'state.vscdb'));
    return paths;
  }

  // Windows
  // Standard path
  paths.push(path.join(appData, 'User', 'globalStorage', 'state.vscdb'));
  // Fallback paths
  paths.push(path.join(appData, 'User', 'state.vscdb'));
  paths.push(path.join(appData, 'state.vscdb'));

  return paths;
}

export function getAntigravityStoragePaths(): string[] {
  const appData = getAppDataDir();
  const paths: string[] = [];
  const home = os.homedir();

  if (isWsl()) {
    paths.push(path.join(appData, 'User', 'globalStorage', 'storage.json'));
    paths.push(path.join(appData, 'User', 'storage.json'));
    paths.push(path.join(appData, 'storage.json'));
    return paths;
  }

  if (process.platform === 'linux') {
    paths.push(path.join(appData, 'User', 'globalStorage', 'storage.json'));
    paths.push(path.join(appData, 'User', 'storage.json'));
    paths.push(path.join(appData, 'storage.json'));
    return paths;
  }

  if (process.platform === 'darwin') {
    paths.push(
      path.join(
        home,
        'Library',
        'Application Support',
        'Antigravity',
        'User',
        'globalStorage',
        'storage.json',
      ),
    );
    paths.push(path.join(home, 'Library', 'Application Support', 'Antigravity', 'storage.json'));
    return paths;
  }

  paths.push(path.join(appData, 'User', 'globalStorage', 'storage.json'));
  paths.push(path.join(appData, 'User', 'storage.json'));
  paths.push(path.join(appData, 'storage.json'));
  return paths;
}

export function getAntigravityStoragePath(): string {
  const paths = getAntigravityStoragePaths();
  return paths.length > 0 ? paths[0] : '';
}

// Keep for backward compatibility if needed, but prefer getAntigravityDbPaths
export function getAntigravityDbPath(): string {
  const paths = getAntigravityDbPaths();
  return paths.length > 0 ? paths[0] : '';
}

export function getAntigravityExecutablePath(): string {
  if (isWsl()) {
    const winUser = getWindowsUser();
    return `/mnt/c/Users/${winUser}/AppData/Local/Programs/Antigravity/Antigravity.exe`;
  }

  switch (process.platform) {
    case 'darwin':
      return '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || '';
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

      const possiblePaths = [
        path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
        path.join(programFilesX86, 'Antigravity', 'Antigravity.exe'),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }

      // No known path found; return empty string (caller must handle missing binary)
      return '';
    }
    case 'linux': {
      const possibleLinuxPaths = [
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/usr/share/antigravity/antigravity',
        '/opt/Antigravity/antigravity',
        '/opt/antigravity/antigravity',
        path.join(os.homedir(), '.local', 'share', 'antigravity', 'antigravity'),
      ];

      for (const p of possibleLinuxPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }

      // Fallback: try `which antigravity` via path lookup
      const fromPath = process.env.PATH?.split(':')
        .map((dir) => path.join(dir, 'antigravity'))
        .find((p) => fs.existsSync(p));
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
