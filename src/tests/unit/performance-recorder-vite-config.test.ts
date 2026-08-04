import { describe, expect, test } from 'vitest';
// @ts-expect-error -- Vitest supports root .mts config imports; this project disallows TS extensions in tsc imports.
import preloadConfig from '../../../vite.preload.config.mts';

describe('performance recorder preload configuration', () => {
  test('exposes only the performance opt-in environment prefix to preload', async () => {
    if (typeof preloadConfig !== 'function') {
      throw new Error('Expected the preload Vite config to be a function');
    }

    const config = await preloadConfig({
      command: 'serve',
      isPreview: false,
      isSsrBuild: false,
      mode: 'development',
    });

    expect(config).toMatchObject({
      envPrefix: ['VITE_', 'ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER'],
    });
    expect(config.define).toBeUndefined();
  });
});
