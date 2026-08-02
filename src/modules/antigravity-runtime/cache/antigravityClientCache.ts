import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@/shared/logging/logger';

export interface AntigravityClientCacheClearResult {
  clearedPaths: string[];
  totalSizeFreed: number;
  errors: string[];
}

export function getAntigravityClientCachePaths(): string[] {
  if (process.platform === 'darwin') {
    const home = os.homedir();
    return [
      path.posix.join(home, 'Library', 'HTTPStorages', 'com.google.antigravity'),
      path.posix.join(home, 'Library', 'Caches', 'com.google.antigravity'),
      path.posix.join(home, '.antigravity'),
      path.posix.join(home, '.config', 'antigravity'),
    ];
  }

  if (process.platform === 'linux') {
    const home = os.homedir();
    const paths = [
      path.posix.join(home, '.cache', 'Antigravity'),
      path.posix.join(home, '.cache', 'google-antigravity'),
      path.posix.join(home, '.antigravity'),
    ];
    if (process.env.XDG_CACHE_HOME) {
      paths.push(path.posix.join(process.env.XDG_CACHE_HOME, 'Antigravity'));
      paths.push(path.posix.join(process.env.XDG_CACHE_HOME, 'google-antigravity'));
    }

    return paths;
  }

  if (process.platform !== 'win32') {
    return [];
  }

  const paths: string[] = [];
  if (process.env.LOCALAPPDATA) {
    paths.push(path.win32.join(process.env.LOCALAPPDATA, 'Google', 'Antigravity'));
    paths.push(path.win32.join(process.env.LOCALAPPDATA, 'Antigravity', 'Cache'));
    paths.push(path.win32.join(process.env.LOCALAPPDATA, 'Antigravity IDE', 'Cache'));
  }
  if (process.env.APPDATA) {
    paths.push(path.win32.join(process.env.APPDATA, 'Antigravity', 'Cache'));
    paths.push(path.win32.join(process.env.APPDATA, 'Antigravity IDE', 'Cache'));
  }

  return paths;
}

function getPathSize(targetPath: string): number {
  const stats = fs.lstatSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.size;
  }

  return fs
    .readdirSync(targetPath)
    .reduce((total, entry) => total + getPathSize(path.join(targetPath, entry)), 0);
}

export function clearAntigravityClientCache(): AntigravityClientCacheClearResult {
  const cachePaths = getAntigravityClientCachePaths();
  logger.info(`Starting Antigravity cache clearing, ${cachePaths.length} potential paths`);

  const result: AntigravityClientCacheClearResult = {
    clearedPaths: [],
    totalSizeFreed: 0,
    errors: [],
  };

  for (const cachePath of cachePaths) {
    if (!fs.existsSync(cachePath)) {
      logger.info(`Cache path does not exist, skipping: ${cachePath}`);
      continue;
    }

    logger.info(`Clearing cache: ${cachePath}`);
    try {
      const size = getPathSize(cachePath);
      fs.rmSync(cachePath, { recursive: true });
      result.clearedPaths.push(cachePath);
      result.totalSizeFreed += size;
      logger.info(`Cleared ${cachePath}: ${(size / 1024 / 1024).toFixed(2)} MB freed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = `Failed to remove ${cachePath}: ${message}`;
      logger.warn(failure);
      result.errors.push(failure);
    }
  }

  logger.info(
    `Antigravity cache clearing completed: ${result.clearedPaths.length} paths cleared, ` +
      `${(result.totalSizeFreed / 1024 / 1024).toFixed(2)} MB freed, ${result.errors.length} errors`,
  );

  return result;
}
