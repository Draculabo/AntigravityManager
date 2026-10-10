import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** Validate the type-2 runtime and ELF architecture before allowing executable replacement. */
export function isCompatibleAppImage(target: string): boolean {
  if (
    (process.arch !== 'x64' && process.arch !== 'arm64') ||
    !path.isAbsolute(target) ||
    target.includes('\0')
  ) {
    return false;
  }

  let descriptor: number | undefined;
  try {
    // A symlink could redirect replacement to a different installation after the check.
    if (!fs.lstatSync(target).isFile()) {
      return false;
    }
    descriptor = fs.openSync(target, 'r');
    const header = Buffer.alloc(20);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      return false;
    }
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return false;
    }
    return (
      header[4] === 2 &&
      header[5] === 1 &&
      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02])) &&
      header.readUInt16LE(18) === (process.arch === 'x64' ? 62 : 183)
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

/** Only the AppImage runtime's writable archive can be replaced by the updater. */
export function getAppImageInstallTarget(): string | null {
  const target = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !app.isPackaged || !target || !isCompatibleAppImage(target)) {
    return null;
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
    fs.accessSync(path.dirname(target), fs.constants.W_OK | fs.constants.X_OK);
    return target;
  } catch {
    return null;
  }
}
