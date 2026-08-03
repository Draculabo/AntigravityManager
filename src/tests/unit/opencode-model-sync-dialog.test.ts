// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, values?: Record<string, unknown>) => {
      if (key === 'proxy.open-code.selected-count') {
        return `${values?.selected} of ${values?.total} selected`;
      }
      return fallback ?? key;
    },
  }),
}));

import { OpenCodeModelSyncDialog } from '@/modules/proxy-gateway/components/OpenCodeModelSyncDialog';

const AVAILABLE_MODELS = [
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
  { id: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' },
  { id: 'vendor-preview', name: 'Vendor Preview' },
];

describe('OpenCodeModelSyncDialog', () => {
  it('submits only the selected models with the custom BaseURL', async () => {
    const onOpenChange = vi.fn();
    const onSync = vi.fn().mockResolvedValue(true);

    render(
      createElement(OpenCodeModelSyncDialog, {
        availableModels: AVAILABLE_MODELS,
        configuredModels: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
        initialBaseUrl: 'http://127.0.0.1:8045/v1',
        syncAccounts: false,
        onOpenChange,
        onSyncAccountsChange: vi.fn(),
        onSync,
      }),
    );

    const geminiCheckbox = screen.getByRole('checkbox', { name: /Gemini 3.5 Flash/ });
    const vendorCheckbox = screen.getByRole('checkbox', { name: /Vendor Preview/ });
    expect(screen.getAllByRole('checkbox', { name: /Gemini 3.5 Flash/ })).toHaveLength(1);
    expect(geminiCheckbox.getAttribute('data-state')).toBe('checked');
    expect(vendorCheckbox.getAttribute('data-state')).toBe('unchecked');

    fireEvent.click(geminiCheckbox);
    fireEvent.click(vendorCheckbox);
    fireEvent.change(screen.getByLabelText('Custom Manager BaseURL'), {
      target: { value: 'http://antigravity-manager:8045/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sync' }));

    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith({
        baseUrl: 'http://antigravity-manager:8045/v1',
        models: [{ id: 'vendor-preview', name: 'Vendor Preview' }],
        syncAccounts: false,
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps a previously configured custom model selectable', () => {
    render(
      createElement(OpenCodeModelSyncDialog, {
        availableModels: AVAILABLE_MODELS,
        configuredModels: [{ id: 'retired-preview', name: 'Retired Preview' }],
        initialBaseUrl: 'http://127.0.0.1:8045/v1',
        syncAccounts: false,
        onOpenChange: vi.fn(),
        onSyncAccountsChange: vi.fn(),
        onSync: vi.fn().mockResolvedValue(true),
      }),
    );

    const checkbox = screen.getByRole('checkbox', { name: /Retired Preview/ });
    expect(checkbox.getAttribute('data-state')).toBe('checked');
  });

  it('exposes the opt-in account sync control', () => {
    const onSyncAccountsChange = vi.fn();
    render(
      createElement(OpenCodeModelSyncDialog, {
        availableModels: AVAILABLE_MODELS,
        configuredModels: [{ id: 'gemini-3.5-flash' }],
        initialBaseUrl: 'http://127.0.0.1:8045/v1',
        syncAccounts: false,
        onOpenChange: vi.fn(),
        onSyncAccountsChange,
        onSync: vi.fn().mockResolvedValue(true),
      }),
    );

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Sync accounts to antigravity-accounts\.json/,
      }),
    );
    expect(onSyncAccountsChange).toHaveBeenCalledWith(true);
  });
});
