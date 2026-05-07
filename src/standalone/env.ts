import fs from 'fs';
import path from 'path';

/**
 * Minimal .env loader. No deps, no surprises:
 * - reads the first .env file found in cwd or its ancestors (up to repo root)
 * - splits each line on the first `=`
 * - strips matching surrounding quotes
 * - skips blanks, comments, and keys already set in process.env
 */
export function loadDotEnv(): { path: string | null; loaded: number } {
  const candidate = findDotEnvUp(process.cwd());
  if (!candidate) {
    return { path: null, loaded: 0 };
  }

  const raw = fs.readFileSync(candidate, 'utf-8');
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) {
      continue;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    count++;
  }

  return { path: candidate, loaded: count };
}

function findDotEnvUp(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}
