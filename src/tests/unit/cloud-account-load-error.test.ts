import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountLoadError } from '@/modules/cloud-account/components/CloudAccountListFallbacks';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'electron');
});

describe('CloudAccountLoadError', () => {
  it('opens recovery links through the Electron external-browser bridge', () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { openExternalUrl },
    });

    render(
      createElement(CloudAccountLoadError, {
        error: {
          appErrorCode: 'MASTER_KEY_UNAVAILABLE',
          messageKey: 'error.masterKeyUnavailable',
          reportToSentry: false,
          metadata: {
            hint: 'HINT_RECOVERY',
            reason: 'NO_MATCHING_KEY',
            storedAccountCount: 1,
          },
        },
        onRetry: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.dataRepair.openRepository' }));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.dataRepair.openIssues' }));

    expect(openExternalUrl).toHaveBeenNthCalledWith(
      1,
      'https://github.com/Draculabo/AntigravityManager',
    );
    expect(openExternalUrl).toHaveBeenNthCalledWith(
      2,
      'https://github.com/Draculabo/AntigravityManager/issues',
    );
  });
});
