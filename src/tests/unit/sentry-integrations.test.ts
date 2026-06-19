import { describe, expect, it } from 'vitest';

import { filterCrashSafeSentryIntegrations } from '@/shared/observability/sentryIntegrations';

describe('Sentry integration filtering', () => {
  it('removes GPU context collection while preserving other integrations', () => {
    const integrations = [
      { name: 'ElectronContext' },
      { name: 'GpuContext' },
      { name: 'OnUnhandledRejection' },
    ];

    expect(filterCrashSafeSentryIntegrations(integrations)).toEqual([
      { name: 'ElectronContext' },
      { name: 'OnUnhandledRejection' },
    ]);
  });
});
