import type { LaunchContext } from '@/modules/antigravity-runtime/types';

export const switchContext: LaunchContext = {
  target: 'classic',
  executablePath: '/fixture/app',
  args: ['--user-data-dir', '/fixture/data'],
  defaultUserDataDir: '/fixture/data',
  pathOptions: { userDataDir: '/fixture/data' },
  processes: [],
};
