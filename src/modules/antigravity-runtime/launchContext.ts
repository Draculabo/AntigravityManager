import fs from 'fs';
import path from 'path';
import {
  getAntigravityExecutablePath,
  getAppDataDir,
  getConfiguredAntigravityArgs,
  getConfiguredAntigravityExecutablePath,
  getPortableUserDataDir,
  isWsl,
} from '@/shared/platform/paths';
import { observeProcesses, toWindowsPath, toWslPath } from './processObserver';
import { processError } from './processErrors';
import type { GuiTarget, LaunchContext, RuntimeProcess } from './types';
import { usesWindowsRuntime } from './runtimePlatform';

function filesystemPath(value: string): string {
  return isWsl() ? toWslPath(value) : value;
}

export function canonicalPath(value: string): string {
  const normalized = filesystemPath(value);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(normalized);
  } catch {
    const parent = path.dirname(normalized);
    resolved =
      parent === normalized
        ? path.resolve(normalized)
        : path.join(canonicalPath(parent), path.basename(normalized));
  }
  return process.platform === 'win32' || (isWsl() && /^\/mnt\/[a-z]\//i.test(resolved))
    ? resolved.toLowerCase()
    : resolved;
}

export function sameInstallation(left: string, right: string): boolean {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  if (canonicalLeft === canonicalRight) {
    return true;
  }
  if (process.platform === 'darwin') {
    const bundle = (value: string) => /^(.*\.app)(?:\/|$)/i.exec(value)?.[1];
    return Boolean(bundle(canonicalLeft) && bundle(canonicalLeft) === bundle(canonicalRight));
  }
  // Official VS Code based distributions ship bin/<name> beside the real binary.
  // Require both the layout and an installed product descriptor, never just a basename.
  if (
    process.platform === 'linux' &&
    !/\.exe$/i.test(canonicalLeft) &&
    !/\.exe$/i.test(canonicalRight)
  ) {
    const wrapperRoot = (value: string) =>
      path.basename(path.dirname(value)) === 'bin' ? path.dirname(path.dirname(value)) : null;
    const root = wrapperRoot(canonicalLeft) || wrapperRoot(canonicalRight);
    const binary = wrapperRoot(canonicalLeft) ? canonicalRight : canonicalLeft;
    return Boolean(
      root &&
      path.dirname(binary) === root &&
      fs.existsSync(path.join(root, 'resources', 'app', 'product.json')),
    );
  }
  return false;
}

function userDataDirs(args: readonly string[], cwd?: string): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === '--user-data-dir') {
      value = args[++i];
    } else if (arg.startsWith('--user-data-dir=')) {
      value = arg.slice('--user-data-dir='.length);
    } else {
      continue;
    }
    if (!value || value.startsWith('--')) {
      throw processError('directory-conflict');
    }
    value = filesystemPath(value);
    if (!path.isAbsolute(value)) {
      if (!cwd) {
        throw processError('directory-conflict');
      }
      value = path.resolve(cwd, value);
    }
    dirs.push(value);
  }
  return dirs;
}

export function resolveLaunchContext(
  target: GuiTarget,
  processes: readonly RuntimeProcess[],
): LaunchContext {
  const configured = getConfiguredAntigravityExecutablePath(target, false);
  const executablePath = filesystemPath(
    configured ||
      processes[0]?.executablePath ||
      getAntigravityExecutablePath(target, { ignoreRunningProcessCache: true }),
  );
  if (!executablePath) {
    throw processError('missing-executable');
  }
  const windows = usesWindowsRuntime(target, executablePath);
  const pathOptions = { isWsl: isWsl() && windows };
  try {
    fs.accessSync(executablePath, windows ? fs.constants.F_OK : fs.constants.X_OK);
    if (
      !fs.statSync(executablePath).isFile() &&
      !(process.platform === 'darwin' && executablePath.endsWith('.app'))
    ) {
      throw processError('missing-executable');
    }
  } catch {
    throw processError('missing-executable');
  }
  if (processes.some((item) => !sameInstallation(executablePath, item.executablePath))) {
    throw processError('target-conflict');
  }

  const configuredArgs = getConfiguredAntigravityArgs(target);
  const configuredDirs = userDataDirs(configuredArgs, process.cwd());
  const observedDirs = processes.flatMap((item) => userDataDirs(item.args, item.cwd));
  if (observedDirs.some((dir) => !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) {
    throw processError('directory-conflict');
  }
  const portable = getPortableUserDataDir(target, {
    executablePath: processes[0]?.executablePath || executablePath,
    ignoreRunningProcessCache: true,
    ...pathOptions,
  });
  const defaultDir =
    portable && fs.existsSync(portable) ? portable : getAppDataDir(target, pathOptions);
  const effectiveDir = configuredDirs[0] || observedDirs[0] || defaultDir;
  const observedEffectiveDirs = processes.map(
    (item) => userDataDirs(item.args, item.cwd)[0] || defaultDir,
  );
  if (
    [...configuredDirs, ...observedDirs, ...observedEffectiveDirs].some(
      (dir) => canonicalPath(dir) !== canonicalPath(effectiveDir),
    )
  ) {
    throw processError('directory-conflict');
  }
  // Normalize only the necessary directory option. Never replay files, URIs or helper arguments.
  const args: string[] = [];
  for (let i = 0; i < configuredArgs.length; i++) {
    if (configuredArgs[i] === '--user-data-dir') {
      i++;
    } else if (!configuredArgs[i].startsWith('--user-data-dir=')) {
      args.push(configuredArgs[i]);
    }
  }
  if (configuredDirs.length || observedDirs.length) {
    if (isWsl() && windows && !/^\/mnt\/[a-z]\//i.test(effectiveDir)) {
      throw processError('directory-conflict');
    }
    args.push('--user-data-dir', isWsl() && windows ? toWindowsPath(effectiveDir) : effectiveDir);
  }
  return Object.freeze({
    target,
    executablePath,
    args: Object.freeze(args),
    defaultUserDataDir: defaultDir,
    pathOptions: Object.freeze({
      userDataDir: effectiveDir,
      executablePath,
      ignoreRunningProcessCache: true,
      ...pathOptions,
    }),
    processes: Object.freeze(
      processes.map((item) => Object.freeze({ ...item, args: Object.freeze([...item.args]) })),
    ),
  });
}

export async function prepareLaunchContext(target: GuiTarget): Promise<LaunchContext> {
  return resolveLaunchContext(target, await observeProcesses(target));
}

export function assertContextProcesses(
  context: LaunchContext,
  processes: readonly RuntimeProcess[],
): void {
  if (processes.some((item) => !sameInstallation(context.executablePath, item.executablePath))) {
    throw processError('target-conflict');
  }
  const defaultDir = context.defaultUserDataDir;
  const dirs = processes.flatMap((item) => {
    const observed = userDataDirs(item.args, item.cwd);
    return observed.length ? observed : [defaultDir];
  });
  if (
    dirs.some(
      (dir) => canonicalPath(dir) !== canonicalPath(context.pathOptions.userDataDir || defaultDir),
    )
  ) {
    throw processError('directory-conflict');
  }
}
