import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function createLiveSentryReader(reporting) {
  const python = path.join(
    os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  );
  const sentryScript = path.join(os.homedir(), '.codex/skills/sentry/scripts/sentry_api.py');
  function sentryRead(command, args = []) {
    const environment = { ...process.env, ...reporting };
    if (!environment.SENTRY_BASE_URL) {
      delete environment.SENTRY_BASE_URL;
    }
    const call = spawnSync(python, [sentryScript, command, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1_048_576,
      env: environment,
    });
    if (call.status !== 0) {
      return {
        ok: false,
        httpStatus: Number(/HTTP (\d{3})/.exec(call.stderr ?? '')?.[1]) || undefined,
      };
    }
    try {
      return { ok: true, data: JSON.parse(call.stdout) };
    } catch {
      return { ok: false };
    }
  }

  return sentryRead;
}
