import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudAccountFileImportPanel } from '@/modules/cloud-account/components/CloudAccountFileImportPanel';
import type { CloudAccountImportResultSchema } from '@/modules/cloud-account/services/cloud-account-file.schema';
import type { z } from 'zod';

const importBackup = vi.hoisted(() => vi.fn());
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useImportCloudAccounts: () => ({ isPending: false, mutateAsync: importBackup }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

describe('CloudAccountFileImportPanel', () => {
  it('keeps a partial backup result visible in the add-account dialog', async () => {
    const importResult = Promise.withResolvers<z.infer<typeof CloudAccountImportResultSchema>>();
    importBackup.mockReturnValueOnce(importResult.promise);
    const onBusyChange = vi.fn();
    render(createElement(CloudAccountFileImportPanel, { onBusyChange }));

    fireEvent.click(screen.getByRole('button', { name: 'cloud.exportImport.import-from-file' }));
    expect(importBackup).toHaveBeenCalledExactlyOnceWith({ strategy: 'merge' });
    expect(onBusyChange.mock.calls).toEqual([[true]]);

    await act(async () =>
      importResult.resolve({
        status: 'imported',
        imported: 1,
        updated: 0,
        skipped: 0,
        failed: 1,
        errors: [{ email: 'person@example.com', code: 'tokens-missing' }],
      }),
    );
    expect(screen.getByRole('status').textContent).toContain('cloud.exportImport.importErrors:1');
    expect(screen.getByRole('listitem').textContent).toBe(
      'person@example.com: cloud.exportImport.file-errors.tokens-missing',
    );
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});
