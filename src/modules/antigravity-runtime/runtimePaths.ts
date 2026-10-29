import fs from 'node:fs';
import path from 'node:path';
import { isWsl } from '@/shared/platform/paths';
import { processError } from './processErrors';

export function toWslPath(value: string): string {
  return value
    .replace(/^([a-z]):[\\/]/i, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

export function toWindowsPath(value: string): string {
  return value
    .replace(/^\/mnt\/([a-z])\//, (_, drive: string) => `${drive.toUpperCase()}:\\`)
    .replace(/\//g, '\\');
}

export function filesystemPath(value: string): string {
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

export function userDataDirs(args: readonly string[], cwd?: string): string[] {
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
