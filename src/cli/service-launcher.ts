import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreStatus } from '@/core/core-service';
import { ServiceNotRunningError } from '@/core/management/client';
import type { ProfileOwner } from '@/core/ownership/profile-lease';
import { ProfileOwnershipError } from '@/core/ownership/profile-lease';

// A packaged cold start can load native modules for longer than 15 seconds on Windows.
const STARTUP_TIMEOUT_MS = 45_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

function isClosingConnection(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ECONNRESET' || error.code === 'EPIPE')
  );
}

export interface ManagementPort {
  status(): Promise<CoreStatus>;
  shutdown(): Promise<void>;
}

export interface LaunchedCore {
  readonly pid?: number;
  hasExited(): boolean;
}

export interface ServiceLauncherOptions {
  management: ManagementPort;
  probeProfileOwner(): Promise<ProfileOwner | null>;
  launchCore(): Promise<LaunchedCore>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export function resolveCoreEntry(cliEntryPath: string): string {
  return path.resolve(path.dirname(cliEntryPath), '..', 'core', 'main.cjs');
}

export function coreEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    // Account switching can launch a GUI client from a standalone Linux core.
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'PULSE_SERVER',
    'WSL_DISTRO_NAME',
    'WSL_INTEROP',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'SENTRY_DSN',
    'SENTRY_RELEASE',
    'ANTIGRAVITY_DESKTOP_PREFERENCES_PATH',
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (source[name] !== undefined) {
      environment[name] = source[name];
    }
  }
  return environment;
}

export async function launchDetachedCore(
  coreEntryPath: string,
  executable: string = process.execPath,
  desktopPreferencesPath?: string,
  errorReportingDsn?: string,
): Promise<LaunchedCore> {
  if (!fs.existsSync(coreEntryPath)) {
    throw new Error(`Core entry is missing: ${coreEntryPath}. Run npm run build:core first.`);
  }

  const child = spawn(executable, [coreEntryPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...coreEnvironment(process.env),
      ...(desktopPreferencesPath
        ? { ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: desktopPreferencesPath }
        : {}),
      ...(errorReportingDsn ? { SENTRY_DSN: errorReportingDsn } : {}),
    },
  });
  await once(child, 'spawn');
  child.unref();
  return {
    pid: child.pid,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

export class ServiceLauncher {
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: ServiceLauncherOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? delay;
  }

  private async currentStatus(): Promise<CoreStatus | null> {
    try {
      return await this.options.management.status();
    } catch (error) {
      if (error instanceof ServiceNotRunningError) {
        return null;
      }
      throw error;
    }
  }

  status(): Promise<CoreStatus | null> {
    return this.currentStatus();
  }

  async start(): Promise<{ status: CoreStatus; alreadyRunning: boolean }> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    let child: LaunchedCore | null = null;
    let childExited = false;
    while (this.now() <= deadline) {
      const status = await this.currentStatus();
      if (status?.state === 'running') {
        return { status, alreadyRunning: child === null };
      }
      if (!status && !child) {
        const owner = await this.options.probeProfileOwner();
        if (owner?.kind === 'desktop') {
          throw new ProfileOwnershipError(owner);
        }
        if (!owner) {
          child = await this.options.launchCore();
        }
      }
      childExited ||= child?.hasExited() ?? false;
      await this.wait(POLL_INTERVAL_MS);
    }
    throw new Error(
      childExited ? 'Core process exited before readiness' : 'Core startup timed out',
    );
  }

  async stop(): Promise<{ alreadyStopped: boolean }> {
    if (!(await this.currentStatus())) {
      return { alreadyStopped: true };
    }
    try {
      await this.options.management.shutdown();
    } catch (error) {
      if (!(error instanceof ServiceNotRunningError) && !isClosingConnection(error)) {
        throw error;
      }
    }

    const deadline = this.now() + (this.options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    while (this.now() <= deadline) {
      try {
        if (!(await this.currentStatus())) {
          return { alreadyStopped: false };
        }
      } catch (error) {
        // A closing private server can reset a status connection. Observe again; never replay shutdown.
        if (!isClosingConnection(error)) {
          throw error;
        }
      }
      await this.wait(POLL_INTERVAL_MS);
    }
    throw new Error('Core acknowledged shutdown but did not stop before the deadline');
  }
}
