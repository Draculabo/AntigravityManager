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
import { observeProcesses } from '@/modules/antigravity-runtime/processObserver';
import { processError } from './processErrors';
import type { GuiTarget, LaunchContext, LaunchContextOptions, RuntimeProcess } from './types';
import { usesWindowsRuntime } from './runtimePlatform';
import { ownsLinuxProfile } from './linuxProfileOwnership';
import { assertNoWindowsUpdate } from './windowsUpdate';
import {
  canonicalPath,
  filesystemPath,
  toWindowsPath,
  toWslPath,
  userDataDirs,
} from './runtimePaths';

export { canonicalPath, filesystemPath, toWindowsPath, toWslPath, userDataDirs };

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

export function extractProcessUserDataDir(proc: RuntimeProcess): string | null {
  try {
    const dirs = userDataDirs(proc.args, proc.cwd);
    if (!dirs.length) {
      return null;
    }
    const first = dirs[0];
    if (dirs.some((d) => canonicalPath(d) !== canonicalPath(first))) {
      return null;
    }
    return first;
  } catch {
    return null;
  }
}

export function filterContextProcesses(
  context: LaunchContext,
  processes: readonly RuntimeProcess[],
): RuntimeProcess[] {
  const targetUserDataDir = context.pathOptions.userDataDir || context.defaultUserDataDir;
  const targetCanonical = canonicalPath(targetUserDataDir);
  return processes.filter((proc) => {
    try {
      let dirs: string[] = [];
      try {
        dirs = userDataDirs(proc.args, proc.cwd);
      } catch {
        return false;
      }
      if (dirs.length) {
        return dirs.some((d) => canonicalPath(d) === targetCanonical);
      }
      if (
        proc.args.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
      ) {
        return false;
      }
      if (process.platform === 'linux' && ownsLinuxProfile(proc.pid, targetUserDataDir)) {
        return true;
      }
      return canonicalPath(context.defaultUserDataDir) === targetCanonical;
    } catch {
      return false;
    }
  });
}

export function resolveLaunchContext(
  target: GuiTarget,
  processes: readonly RuntimeProcess[],
  options?: LaunchContextOptions,
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

  const configuredArgs = getConfiguredAntigravityArgs(target);
  const configuredDirs = userDataDirs(configuredArgs, process.cwd());
  const portable = getPortableUserDataDir(target, {
    executablePath: processes[0]?.executablePath || executablePath,
    ignoreRunningProcessCache: true,
    ...pathOptions,
  });
  const defaultDir =
    portable && fs.existsSync(portable) ? portable : getAppDataDir(target, pathOptions);

  let effectiveDir: string;
  let relevantProcesses: readonly RuntimeProcess[];
  let explicit: string | undefined;

  if (options?.userDataDir !== undefined) {
    explicit = options.userDataDir.trim();
    if (!explicit || explicit.startsWith('--')) {
      throw processError('directory-conflict');
    }
    const normalizedExplicit = filesystemPath(explicit);
    if (!path.isAbsolute(normalizedExplicit)) {
      throw processError('directory-conflict');
    }
    effectiveDir = canonicalPath(normalizedExplicit);
    relevantProcesses = processes.filter((proc) => {
      try {
        let dirs: string[] = [];
        try {
          dirs = userDataDirs(proc.args, proc.cwd);
        } catch {
          return false;
        }
        if (dirs.length) {
          return dirs.some((d) => canonicalPath(d) === effectiveDir);
        }
        if (
          proc.args.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
        ) {
          return false;
        }
        if (process.platform === 'linux' && ownsLinuxProfile(proc.pid, effectiveDir)) {
          return true;
        }
        return canonicalPath(defaultDir) === effectiveDir;
      } catch {
        return false;
      }
    });
  } else {
    const observedDirsAll = processes.flatMap((item) => {
      try {
        return userDataDirs(item.args, item.cwd);
      } catch {
        return [];
      }
    });
    effectiveDir = configuredDirs[0] || observedDirsAll[0] || defaultDir;
    relevantProcesses = processes;
  }

  if (relevantProcesses.some((item) => !sameInstallation(executablePath, item.executablePath))) {
    throw processError('target-conflict');
  }

  const observedDirs = relevantProcesses.flatMap((item) => {
    try {
      return userDataDirs(item.args, item.cwd);
    } catch {
      return [];
    }
  });
  if (observedDirs.some((dir) => !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) {
    throw processError('directory-conflict');
  }

  const canonicalEffectiveDir = canonicalPath(effectiveDir);
  const observedEffectiveDirs = relevantProcesses.map((item) => {
    const raw = extractProcessUserDataDir(item);
    if (raw) {
      return raw;
    }
    return ownsLinuxProfile(item.pid, effectiveDir) ? effectiveDir : defaultDir;
  });

  if (
    [...configuredDirs, ...observedDirs, ...observedEffectiveDirs].some(
      (dir) => canonicalPath(dir) !== canonicalEffectiveDir,
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
  if (options?.userDataDir !== undefined || configuredDirs.length || observedDirs.length) {
    if (isWsl() && windows && !/^\/mnt\/[a-z]\//i.test(effectiveDir)) {
      throw processError('directory-conflict');
    }
    const argDir =
      explicit !== undefined
        ? isWsl() && windows
          ? toWindowsPath(effectiveDir)
          : filesystemPath(explicit)
        : isWsl() && windows
          ? toWindowsPath(effectiveDir)
          : effectiveDir;
    // Standalone Electron clients require Chromium's single-argument switch form.
    args.push(`--user-data-dir=${argDir}`);
  }
  if (options?.projectPath) {
    const projectPath = filesystemPath(options.projectPath);
    args.push(isWsl() && windows ? toWindowsPath(projectPath) : projectPath);
  }

  return Object.freeze({
    target,
    executablePath,
    args: Object.freeze(args),
    defaultUserDataDir: defaultDir,
    pathOptions: Object.freeze({
      userDataDir: canonicalEffectiveDir,
      executablePath,
      ignoreRunningProcessCache: true,
      ...pathOptions,
    }),
    processes: Object.freeze(
      relevantProcesses.map((item) =>
        Object.freeze({ ...item, args: Object.freeze([...item.args]) }),
      ),
    ),
    projectPath: options?.projectPath ? filesystemPath(options.projectPath) : undefined,
  });
}

export async function prepareLaunchContext(
  target: GuiTarget,
  options?: LaunchContextOptions,
): Promise<LaunchContext> {
  await assertNoWindowsUpdate(target);
  return resolveLaunchContext(target, await observeProcesses(target), options);
}

export function assertContextProcesses(
  context: LaunchContext,
  processes: readonly RuntimeProcess[],
): void {
  const relevantProcesses = filterContextProcesses(context, processes);

  if (
    relevantProcesses.some((item) => !sameInstallation(context.executablePath, item.executablePath))
  ) {
    throw processError('target-conflict');
  }
  const defaultDir = context.defaultUserDataDir;
  const targetDir = context.pathOptions.userDataDir || defaultDir;
  const canonicalTarget = canonicalPath(targetDir);

  const dirs = relevantProcesses.flatMap((item) => {
    let observed: string[] = [];
    try {
      observed = userDataDirs(item.args, item.cwd);
    } catch {
      observed = [];
    }
    return observed.length
      ? observed
      : [ownsLinuxProfile(item.pid, targetDir) ? targetDir : defaultDir];
  });
  if (dirs.some((dir) => canonicalPath(dir) !== canonicalTarget)) {
    throw processError('directory-conflict');
  }
}
