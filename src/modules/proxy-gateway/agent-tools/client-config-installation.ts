import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Detection never shares the configuration write queue; one selected executable has a 5s budget. */
export async function detectClientConfigInstallation(client: 'hermes' | 'openclaw') {
  const windows = process.platform === 'win32';
  const directories = [...new Set([
    ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).slice(0, 128),
    join(homedir(), '.local', 'bin'), join(homedir(), '.hermes', 'bin'),
    ...(windows && process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
    ...(windows && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'pnpm')] : []),
    ...(!windows ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] : []),
  ])];
  let executable: string | null = null;
  for (const directory of directories) {
    for (const extension of windows ? ['.exe', '.cmd', '.bat'] : ['']) {
      const candidate = join(directory, `${client}${extension}`);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          executable = candidate;
          break;
        }
      } catch {
        // A missing PATH candidate is not a configuration read failure.
      }
    }
    if (executable !== null) {
      break;
    }
  }
  if (executable === null) {
    return { installed: false, version: null };
  }
  // Shell wrappers remain installed with an unknown version rather than invoking a command shell.
  if (windows && extname(executable).toLowerCase() !== '.exe') {
    return { installed: true, version: null };
  }
  try {
    const { stdout, stderr } = await execute(executable, ['--version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
      env: { ...process.env, PATH: [dirname(process.execPath), dirname(executable), process.env.PATH ?? ''].join(delimiter) },
    });
    const version = `${stdout}\n${stderr}`.match(/\b\d{1,4}(?:\.\d{1,4}){1,3}(?:-[\w.]+)?\b/)?.[0] ?? null;
    return { installed: true, version };
  } catch {
    return { installed: true, version: null };
  }
}
