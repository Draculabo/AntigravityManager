import fs from 'fs';
import os from 'os';
import path from 'path';

export interface AgyCliPathDetectionOptions {
  bypassConfig?: boolean;
  configuredPath?: string | null;
  exists?: (candidatePath: string) => boolean;
  homeDirectory?: string;
  pathEnvironment?: string;
  platform?: NodeJS.Platform;
}

/**
 * Locate the agy executable using the same precedence as the upstream implementation.
 *
 * A forced detection intentionally excludes the configured path so the Detect action
 * cannot return a stale-but-existing selection.
 */
export function detectAgyCliExecutablePath(
  options: AgyCliPathDetectionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const executableName = platform === 'win32' ? 'agy.exe' : 'agy';
  const exists = options.exists ?? ((candidatePath: string) => fs.existsSync(candidatePath));

  if (!options.bypassConfig) {
    const configuredPath = options.configuredPath?.trim();
    if (configuredPath && exists(configuredPath)) {
      return configuredPath;
    }
  }

  const homeDirectory = options.homeDirectory ?? os.homedir();
  const userLocalPath = pathApi.join(homeDirectory, '.local', 'bin', executableName);
  if (exists(userLocalPath)) {
    return userLocalPath;
  }

  const pathEnvironment = options.pathEnvironment ?? process.env.PATH;
  if (pathEnvironment) {
    for (const directory of pathEnvironment.split(pathApi.delimiter)) {
      if (!directory) {
        continue;
      }

      const candidatePath = pathApi.join(directory, executableName);
      if (exists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}
