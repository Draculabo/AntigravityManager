import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';

/** Abort the matrix on a stalled browser/IPC observation, then let its owner tear down clients. */
export async function withAcceptanceDeadline(action, timeout = 90000) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Acceptance operation exceeded its deadline');
          error.code = 'acceptance-operation-timeout';
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Capture bounded private output; expose only known error categories to reports. */
export function createCommand(environment) {
  return async function command(executable, args, timeout = 90000) {
    const child = spawn(executable, args, {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      stdout = (stdout + chunk).slice(-1000000);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      stderr = (stderr + chunk).slice(-5000);
    });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
      const [exitCode] = await once(child, 'close');
      if (exitCode !== 0) {
        const error = new Error('Client command failed');
        error.code = `exit-${exitCode}`;
        const text = `${stdout}\n${stderr}`;
        error.failureCategories = [
          ...new Set(
            text.match(
              /ECONNRESET|ENOTFOUND|ETIMEDOUT|429|403|401|busy|ambiguous|expired|invalid|missing|unavailable|credential|snapshot/gi,
            ) ?? [],
          ),
        ];
        throw error;
      }
      return { stdout, bytes };
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function connectBrowser(port, startupError) {
  const deadline = Date.now() + 60000;
  const endpoint = `http://127.0.0.1:${port}`;
  let debuggerReady = false;
  let failureCategories;
  while (Date.now() < deadline) {
    const error = startupError();
    if (error) {
      throw error;
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) {
        debuggerReady = true;
        const { webSocketDebuggerUrl } = await response.json();
        const debuggerUrl = new URL(webSocketDebuggerUrl);
        if (
          debuggerUrl.origin !== `ws://127.0.0.1:${port}` ||
          !debuggerUrl.pathname.startsWith('/devtools/browser/') ||
          debuggerUrl.username ||
          debuggerUrl.password
        ) {
          throw new Error('Unexpected loopback debugger endpoint');
        }
        return await chromium.connectOverCDP(debuggerUrl.href, {
          timeout: Math.min(15000, Math.max(1, deadline - Date.now())),
        });
      }
    } catch (error) {
      // The owned browser can open its port before DevTools accepts a session.
      failureCategories = String(error).match(
        /ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INVALID_ARG_TYPE|Browser closed|Target closed|timeout|unexpected server response/gi,
      );
    }
    await delay(500);
  }
  throw Object.assign(new Error('Client window did not become ready'), {
    code: debuggerReady
      ? 'acceptance-devtools-session-timeout'
      : 'acceptance-devtools-http-timeout',
    failureCategories: failureCategories ? [...new Set(failureCategories)] : undefined,
  });
}
