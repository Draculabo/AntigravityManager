import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';

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
  while (Date.now() < deadline) {
    const error = startupError();
    if (error) {
      throw error;
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
    } catch {
      await delay(500);
    }
  }
  throw new Error('Client window did not become ready');
}
