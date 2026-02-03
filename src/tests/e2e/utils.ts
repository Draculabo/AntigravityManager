import fs from 'fs';
import path from 'path';

/**
 * Returns the absolute path to the Electron main process build file.
 * Throws an error if the build file is not found.
 */
export function getAppBuildPath(): string {
  const buildPath = path.resolve(__dirname, '../../../.vite/build/main.js');

  if (!fs.existsSync(buildPath)) {
    throw new Error(
      `Electron build file not found at: ${buildPath}\n` +
      'Please run "npm run build" to generate the build before running E2E tests.'
    );
  }

  return buildPath;
}
