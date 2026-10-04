import path from 'node:path';

export const STANDALONE_RESOURCE_NAME = 'standalone';

/** Node resolves its own dependencies beside core/CLI, outside Electron's ASAR/native ABI tree. */
export function getStandaloneRuntimePaths(
  resources: string,
  platform: NodeJS.Platform = process.platform,
) {
  const root = path.join(resources, STANDALONE_RESOURCE_NAME);
  return {
    root,
    coreEntry: path.join(root, 'core', 'main.cjs'),
    cliEntry: path.join(root, 'cli', 'main.cjs'),
    nodeExecutable: path.join(root, 'node', platform === 'win32' ? 'node.exe' : 'node'),
  };
}
