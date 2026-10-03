import { spawn } from 'child_process';
import path from 'path';
import {
  resolveAntigravityAppTarget,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { logger } from '@/shared/logging/logger';
import { AppError } from '@/shared/errors/appError';
import { prepareLaunchContext, assertContextProcesses } from './launchContext';
import { getProcessProbeTimeout, observeProcesses } from './processObserver';
import { runProcessOperation } from './operation';
import { processError } from './processErrors';
import type { LaunchContext } from './types';
import { usesWindowsRuntime } from './runtimePlatform';

export function launchEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const mount = source.APPDIR;
  if (!mount || !/^\/tmp\/\.mount_[^/]+/.test(mount)) {
    return env;
  }
  const insideMount = (value: string) => value === mount || value.startsWith(`${mount}/`);
  for (const key of [
    'PATH',
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
    'PYTHONPATH',
    'XDG_DATA_DIRS',
    'GTK_PATH',
    'GIO_EXTRA_MODULES',
    'QT_PLUGIN_PATH',
  ]) {
    if (env[key]) {
      const separator = key === 'LD_PRELOAD' ? /[ :]/ : /:/;
      const values = env[key].split(separator).filter((value) => !insideMount(value));
      if (values.length) {
        env[key] = values.join(':');
      } else {
        delete env[key];
      }
    }
  }
  delete env.APPDIR;
  delete env.APPIMAGE;
  if (env.ARGV0 === source.APPIMAGE || (env.ARGV0 && insideMount(env.ARGV0))) {
    delete env.ARGV0;
  }
  return env;
}

async function dispatchLaunch(context: LaunchContext): Promise<void> {
  let executable = context.executablePath;
  let args = [...context.args];
  if (process.platform === 'darwin') {
    const bundle = /^(.*?\.app)(?:\/|$)/i.exec(executable)?.[1];
    if (bundle) {
      executable = 'open';
      args = [bundle, ...(args.length ? ['--args', ...args] : [])];
    }
  } else if (process.platform === 'linux' && !usesWindowsRuntime(context.target, executable)) {
    const gpu = process.env.ANTIGRAVITY_MANAGER_ENABLE_LINUX_GPU?.trim().toLowerCase();
    if (gpu !== '1' && gpu !== 'true') {
      for (const flag of ['--disable-gpu', '--disable-gpu-compositing']) {
        if (!args.includes(flag)) {
          args.push(flag);
        }
      }
    }
  }
  // WSL interop executes the mounted .exe directly; argv never passes through cmd.exe.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      // SW_HIDE can suppress a GUI application's first window on Windows.
      windowsHide: process.platform !== 'win32',
      ...(process.platform === 'win32' ? { cwd: path.win32.dirname(executable) } : {}),
      env: launchEnvironment(),
    });
    child.once('error', () => reject(processError('launch-failed')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** One dispatch only, followed by bounded observation. Timeout never dispatches again. */
export async function startFromContext(context: LaunchContext): Promise<void> {
  logger.info(`Starting Antigravity target: ${context.target}`);
  try {
    await dispatchLaunch(context);
  } catch {
    throw processError('launch-failed');
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const processes = await observeProcesses(
        context.target,
        Math.min(
          getProcessProbeTimeout(context.target, context.executablePath),
          deadline - Date.now(),
        ),
        context.executablePath,
      );
      assertContextProcesses(context, processes);
      if (processes.length) {
        logger.info(`Antigravity startup confirmed: ${context.target}`);
        return;
      }
    } catch (error) {
      // A failed probe is inconclusive. The single startup deadline still applies.
      logger.warn('Antigravity startup observation inconclusive', {
        target: context.target,
        reason: error instanceof AppError ? error.messageKey : 'unavailable',
      });
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
  }
  throw processError('startup-unconfirmed');
}

export async function startAntigravity(target?: AntigravityAppTarget | null): Promise<void> {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    throw processError('missing-executable');
  }
  return runProcessOperation(resolved, 'starting', async () => {
    const context = await prepareLaunchContext(resolved);
    if (context.processes.length) {
      return;
    }
    await startFromContext(context);
  });
}
