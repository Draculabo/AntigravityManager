import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Chromium may erase argv. Require its live singleton owner and an open profile lock. */
export function ownsLinuxProfile(pid: number, directory: string): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    const profile = fs.realpathSync(directory);
    const singleton = fs.readlinkSync(path.posix.join(profile, 'SingletonLock'));
    const prefix = `${os.hostname()}-`;
    if (!singleton.startsWith(prefix)) {
      return false;
    }
    const owner = Number(singleton.slice(prefix.length));
    if (!Number.isSafeInteger(owner) || owner <= 0) {
      return false;
    }
    const expectedLock = path.posix.join(profile, 'Local Storage', 'leveldb', 'LOCK');
    const ownerHasLock = fs.readdirSync(`/proc/${owner}/fd`).some((descriptor) => {
      try {
        return fs.readlinkSync(`/proc/${owner}/fd/${descriptor}`) === expectedLock;
      } catch {
        return false;
      }
    });
    if (!ownerHasLock) {
      return false;
    }
    const ownerExecutable = fs.realpathSync(`/proc/${owner}/exe`);
    const seen = new Set<number>();
    let current = pid;
    while (current > 1 && seen.size < 32 && !seen.has(current)) {
      if (fs.realpathSync(`/proc/${current}/exe`) !== ownerExecutable) {
        return false;
      }
      if (current === owner) {
        return fs.readlinkSync(path.posix.join(profile, 'SingletonLock')) === singleton;
      }
      seen.add(current);
      const status = fs.readFileSync(`/proc/${current}/status`, 'utf8');
      current = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
    }
  } catch {
    // Missing locks, exiting processes and inaccessible metadata are not ownership proof.
  }
  return false;
}
